import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../ui/dist')
function assetPath(url) {
  const path = /^https?:/.test(url) ? new URL(url).pathname : url
  const absolute = resolve(root, decodeURIComponent(path.replace(/^\//, '').split(/[?#]/)[0]))
  if (relative(root, absolute).startsWith('..')) throw new Error(`Asset outside build directory: ${url}`)
  return absolute
}
const startupLabels = {}
for (const locale of ['az', 'en', 'es', 'it', 'ja', 'ko', 'pt-BR', 'tr', 'zh-CN', 'zh-TW']) {
  const resource = JSON.parse(await readFile(resolve(root, '../src/i18n/locales', locale + '.json'), 'utf8'))
  startupLabels[locale.toLowerCase()] = { loading: resource.common.loading, error: resource.common.error }
}
let html = await readFile(resolve(root, 'index.html'), 'utf8')
for (const match of [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)]) {
  const js = await readFile(assetPath(match[1]), 'utf8')
  // DBX caps a single asset at 8 MiB. Compress the self-contained module and
  // decode locally; blob: modules are allowed by the host's srcdoc CSP.
  const compressed = gzipSync(js, {level: 9}).toString('base64')
  html = html.replace(match[0], '').replace('</body>', `<script>
(async () => {
const labels = ${JSON.stringify(startupLabels)};
const messages = () => { const locale = String(window.dbxPlugin?.locale || navigator.language || 'en').replace(/_/g, '-').toLowerCase(); return labels[locale] || labels[locale.startsWith('zh') ? (/tw|hk|hant/.test(locale) ? 'zh-tw' : 'zh-cn') : locale.startsWith('pt') ? 'pt-br' : locale.split('-')[0]] || labels.en; };
try {
  document.getElementById('root').textContent = messages().loading;
  const reportError = error => { let alert = document.getElementById('dbx-startup-error'); if (!alert) { alert = document.createElement('div'); alert.id = 'dbx-startup-error'; alert.setAttribute('role', 'alert'); document.body.appendChild(alert); } alert.textContent = messages().error + ': ' + String(error?.message || error); };
  window.addEventListener('error', event => reportError(event.error || event.message));
  window.addEventListener('unhandledrejection', event => reportError(event.reason));
  await window.dbxPlugin.ready;
  const connectionId = window.dbxPlugin.context?.connectionId;
  const stored = await window.dbxPlugin.invoke('ui/preferences-get', {connectionId});
  const values = new Map(Object.entries(stored.values || {}));
  let persistence = Promise.resolve();
  const persist = (key, value) => { persistence = persistence.then(() => window.dbxPlugin.invoke('ui/preferences-set', {connectionId, key, value})).catch(reportError); };
  const storage = {get length() { return values.size; }, key(index) {return [...values.keys()][index] ?? null;}, getItem(key) {return values.get(String(key)) ?? null;}, setItem(key, value) { key = String(key); value = String(value); values.set(key, value); persist(key, value); }, removeItem(key) { key = String(key); values.delete(key); persist(key, null); }, clear() { for (const key of [...values.keys()]) this.removeItem(key); }};
  Object.defineProperty(window, 'localStorage', {value: storage, configurable: true});
  const transient = new Map();
  Object.defineProperty(window, 'sessionStorage', {value: {get length(){return transient.size;}, key(index){return [...transient.keys()][index] ?? null;}, getItem(key){return transient.get(String(key)) ?? null;}, setItem(key,value){transient.set(String(key),String(value));}, removeItem(key){transient.delete(String(key));}, clear(){transient.clear();}}, configurable: true});

  const compressed = Uint8Array.from(atob("${compressed}"), character => character.charCodeAt(0));
  const source = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  document.getElementById('root').textContent = messages().loading;
  const moduleURL = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
  try { await import(moduleURL); } finally { URL.revokeObjectURL(moduleURL); }
} catch (error) { document.getElementById('root').textContent = messages().error + ': ' + String(error); console.error(error); }
})();
</script></body>`)

}
for (const match of [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]) {
  const css = await readFile(assetPath(match[1]), 'utf8')
  // Vite must inline fonts and images as well as scripts and stylesheets.
  for (const url of css.matchAll(/url\(\s*['"]?([^'"\s)]+)/g)) {
    if (!/^(data:|blob:|#)/.test(url[1])) throw new Error(`External CSS asset in srcdoc build: ${url[1]}`)
  }
  html = html.replace(match[0], `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
}
if (/<script\b[^>]*\bsrc=|<link\b[^>]*rel="(?:stylesheet|modulepreload)"/i.test(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''))) {
  throw new Error('DBX build still contains external executable assets')
}
if (Buffer.byteLength(html) > 8 * 1024 * 1024) throw new Error('DBX HTML exceeds 8 MiB asset limit')
await writeFile(resolve(root, 'index.html'), html)
