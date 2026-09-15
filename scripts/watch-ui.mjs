import {watch} from 'node:fs'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const ui = fileURLToPath(new URL('../ui/', import.meta.url))
let timer, running = false, pending = false
async function build() {
  if (running) {pending = true; return}
  running = true
  const child = spawn(process.execPath, [ui + 'node_modules/vite/bin/vite.js', 'build'], {cwd:ui,stdio:'inherit'})
  await new Promise(resolve => child.once('exit',resolve))
  running = false
  if (pending) {pending = false; void build()}
}
function changed() {clearTimeout(timer);timer=setTimeout(() => {void build()}, 350)}
watch(ui + 'src', {recursive:true}, changed)
for (const file of ['index.html','vite.config.ts']) watch(ui + file, changed)
console.log('Watching UI source files; generated assets are excluded.')
