#!/usr/bin/env node
/**
 * Rebuild and repackage the plugin whenever source files changed since the last
 * successful package. Every rebuild bumps the patch version, so each .dbxp can be
 * installed next to the previous one.
 *
 *   node scripts/auto-package.mjs           # rebuild only when sources changed
 *   node scripts/auto-package.mjs --force   # rebuild regardless of the fingerprint
 *   node scripts/auto-package.mjs --check   # report status only, never build
 *   node scripts/auto-package.mjs --json    # machine-readable summary on stdout
 */
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST = path.join(ROOT, 'dist')
const STATE_FILE = path.join(DIST, '.auto-package-state.json')
const LOG_FILE = path.join(DIST, 'auto-package.log')

// Directories that never take part in the fingerprint.
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.dbx-dev', '.git', 'tmp', '.pnpm-store', '__pycache__'])

// Places that repeat the plugin version. The host rejects a sidecar whose handshake
// version differs from the packaged manifest.json, so a bump has to land in all of
// them at once. Each file is hashed with the literal masked out, otherwise the bump
// below would look like a source change and rebuild forever.
const VERSION_SYNC = [
  {file: 'backend/main.go', regex: /Version: "\d+\.\d+\.\d+"/, rewrite: version => `Version: "${version}"`},
  {file: 'backend/internal/kube/client.go', regex: /dbx-plugin-k8s\/\d+\.\d+\.\d+/, rewrite: version => `dbx-plugin-k8s/${version}`},
]

// Everything that can change the packaged bytes.
const WATCHED = [
  'assets',
  'backend',
  'manifest.json',
  'dbx-plugin.toml',
  'scripts/check-i18n.mjs',
  'scripts/inline-ui-assets.mjs',
  'ui/index.html',
  'ui/package.json',
  'ui/src',
  'ui/tsconfig.app.json',
  'ui/tsconfig.json',
  'ui/tsconfig.node.json',
  'ui/vite.config.ts',
]

const argv = process.argv.slice(2)
const FORCE = argv.includes('--force')
const CHECK_ONLY = argv.includes('--check')
const JSON_OUT = argv.includes('--json')

function log(message) {
  mkdirSync(DIST, {recursive: true})
  writeFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, {flag: 'a'})
}

// ---------------------------------------------------------------- tooling lookup

const pathDirs = (() => {
  // The node running this script owns the matching npm/pnpm/dbx-plugin launchers,
  // so its directory wins. The inherited PATH comes next: a hook may start with a
  // minimal PATH, but when it does have one it names the toolchain the developer
  // actually uses (a Homebrew go ahead of a gvm go breaks GOROOT).
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)]
  const gvm = path.join(homedir(), '.gvm', 'gos')
  if (existsSync(gvm)) {
    for (const version of readdirSync(gvm).sort().reverse()) dirs.push(path.join(gvm, version, 'bin'))
  }
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/local/go/bin', path.join(homedir(), 'go', 'bin'))
  return [...new Set(dirs.filter(Boolean))]
})()

function childEnv() {
  return {
    ...process.env,
    PATH: pathDirs.join(path.delimiter),
    GOCACHE: process.env.GOCACHE || path.join(tmpdir(), 'dbx-plugin-k8s-gocache'),
  }
}

// JS launchers (dbx-plugin, pnpm) are symlinks to .js/.cjs files; run them through
// node rather than relying on their executable bit.
function toolCommand(name) {
  for (const dir of pathDirs) {
    const candidate = path.join(dir, name)
    if (!existsSync(candidate)) continue
    const real = realpathSync(candidate)
    return /\.(cjs|mjs|js)$/.test(real) ? {cmd: process.execPath, args: [real]} : {cmd: candidate, args: []}
  }
  throw new Error(`required tool '${name}' not found on PATH (searched: ${pathDirs.join(', ')})`)
}

function withArgs(name, ...args) {
  const command = toolCommand(name)
  return {cmd: command.cmd, args: [...command.args, ...args]}
}

function run(label, command, cwd) {
  const result = spawnSync(command.cmd, command.args, {cwd, env: childEnv(), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024})
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status})\n${output}`)
  log(`${label} ok`)
  return output
}

// ---------------------------------------------------------------- fingerprint

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function normalize(relative, raw) {
  if (relative === 'manifest.json') {
    const manifest = JSON.parse(raw.toString('utf8'))
    delete manifest.version
    return stableStringify(manifest)
  }
  const target = VERSION_SYNC.find(entry => entry.file === relative)
  return target ? raw.toString('utf8').replace(target.regex, '@version@') : raw
}

function collect(relative, entries) {
  const absolute = path.join(ROOT, relative)
  if (!existsSync(absolute)) return
  if (statSync(absolute).isDirectory()) {
    for (const name of readdirSync(absolute).sort()) {
      if (IGNORED_DIRS.has(name)) continue
      collect(path.join(relative, name), entries)
    }
    return
  }
  entries.push(`${relative}\0${sha256(normalize(relative, readFileSync(absolute)))}`)
}

function fingerprint() {
  const entries = []
  for (const relative of WATCHED) collect(relative, entries)
  entries.sort()
  return sha256(entries.join('\n'))
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- version handling

function versionSource(target) {
  const file = path.join(ROOT, target.file)
  const found = readFileSync(file, 'utf8').match(target.regex)
  // A hand-edited version that no longer matches the pattern would otherwise be
  // silently skipped, leaving the sidecar reporting a stale version.
  if (!found) throw new Error(`${target.file} has no version literal matching ${target.regex}`)
  return found[0]
}

function readVersion() {
  const version = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version
  for (const target of VERSION_SYNC) {
    const current = versionSource(target).match(/\d+\.\d+\.\d+/)[0]
    if (current !== version) {
      throw new Error(`${target.file} reports ${current} but manifest.json reports ${version}; align them before rebuilding`)
    }
  }
  return version
}

function writeVersion(version) {
  const manifestFile = path.join(ROOT, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.version = version
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
  for (const target of VERSION_SYNC) {
    const file = path.join(ROOT, target.file)
    writeFileSync(file, readFileSync(file, 'utf8').replace(target.regex, target.rewrite(version)))
  }
}

function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`manifest version '${version}' is not plain semver; bump it by hand`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

// ---------------------------------------------------------------- main

function summarize(status, extra) {
  return {status, ...extra}
}

function emit(summary) {
  log(`result: ${JSON.stringify(summary)}`)
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else if (!CHECK_ONLY) console.log(JSON.stringify(summary, null, 2))
}

// The dev host starts a prebuilt backend from .dbx-dev/bin, so a version bump has to
// reach that binary too or `dbx-plugin dev` handshakes with a stale version.
function refreshDevBinary() {
  const binDir = path.join(ROOT, '.dbx-dev', 'bin')
  if (!existsSync(binDir)) return
  const names = readdirSync(binDir).filter(name => name.startsWith('dbx-plugin'))
  const canonical = 'dbx-plugin-kubernetes'
  if (!names.includes(canonical)) names.push(canonical)
  const target = path.join(binDir, canonical)
  run('dev binary', withArgs('go', 'build', '-o', target, '.'), path.join(ROOT, 'backend'))
  for (const name of names) {
    if (name !== canonical) copyFileSync(target, path.join(binDir, name))
  }
  log(`refreshed dev binaries: ${names.join(', ')}`)
}

function main() {
  mkdirSync(DIST, {recursive: true})
  const fingerprintNow = fingerprint()
  const state = readState()
  const packaged = state?.package ? path.join(ROOT, state.package) : null
  const upToDate = !FORCE && state?.fingerprint === fingerprintNow && packaged && existsSync(packaged)

  if (upToDate) {
    emit(summarize('up-to-date', {version: state.version, package: state.package, reason: 'no source changes since the last package'}))
    return 0
  }
  if (CHECK_ONLY) {
    emit(summarize('stale', {version: readVersion(), reason: FORCE ? 'forced' : 'sources changed since the last package'}))
    return 0
  }

  const previousVersion = readVersion()
  const version = nextPatch(previousVersion)
  log(`rebuilding ${previousVersion} -> ${version}`)

  run('ui build', withArgs('pnpm', 'run', 'build'), path.join(ROOT, 'ui'))

  writeVersion(version)
  try {
    refreshDevBinary()
    run('package', withArgs('dbx-plugin', 'package', '.', '--output-dir', 'dist'), ROOT)
  } catch (error) {
    // Leave manifest.json on the last version that actually produced a package.
    try {
      if (readVersion() === version) writeVersion(previousVersion)
    } catch (rollbackError) {
      log(`version rollback skipped: ${rollbackError.message}`)
    }
    throw error
  }

  const pattern = `io.dbx.k8s-${version}-`
  const packageName = readdirSync(DIST).find(name => name.startsWith(pattern) && name.endsWith('.dbxp'))
  if (!packageName) throw new Error(`packaging reported success but no ${pattern}*.dbxp is in dist/`)
  const packagePath = path.join(DIST, packageName)
  const bytes = readFileSync(packagePath)
  const artifact = JSON.parse(readFileSync(packagePath.replace(/\.dbxp$/, '.artifact.json'), 'utf8'))

  const inspector = path.join(homedir(), '.agents', 'skills', 'dbx-plugin', 'scripts', 'inspect-dbxp.mjs')
  if (existsSync(inspector)) {
    try {
      run('inspect', {cmd: process.execPath, args: [inspector, packagePath]}, ROOT)
    } catch (error) {
      // A package that fails its own checksum check must not be reported as a success.
      log(`inspect FAILED: ${error.message}`)
      throw error
    }
  }

  const summary = summarize('built', {
    previousVersion,
    version,
    package: path.relative(ROOT, packagePath),
    target: artifact.target,
    sha256: sha256(bytes),
    size: bytes.length,
    artifactSha256: artifact.sha256,
    checksumMatches: artifact.sha256 === sha256(bytes) && artifact.size === bytes.length,
  })
  if (!summary.checksumMatches) throw new Error(`${packageName} does not match its .artifact.json checksum`)
  writeFileSync(STATE_FILE, `${JSON.stringify({fingerprint: fingerprintNow, ...summary}, null, 2)}\n`)
  emit(summary)
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  log(`ERROR ${error.stack || error.message}`)
  const summary = summarize('failed', {error: error.message})
  try {
    summary.version = readVersion()
  } catch {
    // The failure is usually version drift, in which case readVersion() is what threw.
  }
  emit(summary)
  process.exitCode = 1
}
