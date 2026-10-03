import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptSource = path.join(path.dirname(fileURLToPath(import.meta.url)), 'auto-package.mjs')

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'dbx-auto-package-'))
  mkdirSync(path.join(root, 'scripts'), { recursive: true })
  mkdirSync(path.join(root, 'backend', 'internal', 'kube'), { recursive: true })
  mkdirSync(path.join(root, 'dist'), { recursive: true })
  writeFileSync(path.join(root, 'scripts', 'auto-package.mjs'), readScriptSource())
  writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({ id: 'io.dbx.k8s', version: '0.1.1' }, null, 2) + '\n'
  )
  writeFileSync(path.join(root, 'backend', 'main.go'), 'dbx.Metadata{Version: "0.1.1"}\n')
  writeFileSync(
    path.join(root, 'backend', 'internal', 'kube', 'client.go'),
    'cfg.UserAgent = "dbx-plugin-k8s/0.1.1"\n'
  )
  return root
}

function readScriptSource() {
  // The test runs the actual script logic from an isolated project directory.
  return readFileSync(scriptSource)
}

function run(root) {
  const result = runRaw(root)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function runRaw(root) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'auto-package.mjs'), '--check', '--json'],
    { cwd: root, encoding: 'utf8' }
  )
  return { ...result, parsed: result.stdout ? JSON.parse(result.stdout) : null }
}

function readFixtureFile(root, relative) {
  return readFileSync(path.join(root, relative), 'utf8')
}

function seedCachedState(root, fingerprint) {
  writeFileSync(path.join(root, 'dist', 'io.dbx.k8s-0.1.1-darwin-arm64.dbxp'), '')
  writeFileSync(
    path.join(root, 'dist', '.auto-package-state.json'),
    JSON.stringify({
      status: 'built',
      version: '0.1.1',
      fingerprint,
      package: 'dist/io.dbx.k8s-0.1.1-darwin-arm64.dbxp',
    })
  )
}

test('reports cached packages as up-to-date and rejects any version drift', () => {
  const root = fixture()
  try {
    const first = run(root)
    assert.equal(first.status, 'stale')
    assert.equal(first.version, '0.1.1')
    assert.equal(first.nextVersion, '0.1.2')

    seedCachedState(root, first.fingerprint)

    const cached = run(root)
    assert.equal(cached.status, 'up-to-date')
    assert.equal(cached.version, '0.1.1')

    for (const [relative, content, expected] of [
      ['manifest.json', JSON.stringify({ id: 'io.dbx.k8s', version: '0.1.9' }, null, 2) + '\n', /manifest\.json/],
      ['backend/main.go', 'dbx.Metadata{Version: "0.1.9"}\n', /backend\/main\.go reports 0\.1\.9/],
      ['backend/internal/kube/client.go', 'cfg.UserAgent = "dbx-plugin-k8s/0.1.9"\n', /client\.go reports 0\.1\.9/],
    ]) {
      const driftRoot = fixture()
      try {
        const baseline = run(driftRoot)
        seedCachedState(driftRoot, baseline.fingerprint)
        writeFileSync(path.join(driftRoot, relative), content)
        const driftResult = runRaw(driftRoot)
        assert.equal(driftResult.status, 1, driftResult.stderr)
        assert.equal(driftResult.parsed.status, 'failed')
        assert.match(driftResult.parsed.error, expected)
      } finally {
        rmSync(driftRoot, { recursive: true, force: true })
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reports synchronized bumps as stale and skips occupied package versions', () => {
  const root = fixture()
  try {
    const first = run(root)
    writeFileSync(path.join(root, 'dist', 'io.dbx.k8s-0.1.2-darwin-arm64.dbxp'), '')
    writeFileSync(path.join(root, 'dist', 'io.dbx.k8s-0.1.3-darwin-arm64.artifact.json'), '{}')
    seedCachedState(root, first.fingerprint)

    writeFileSync(path.join(root, 'backend', 'main.go'), 'dbx.Metadata{Version: "0.1.2"}\n')
    writeFileSync(path.join(root, 'backend', 'internal', 'kube', 'client.go'), 'cfg.UserAgent = "dbx-plugin-k8s/0.1.2"\n')
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: 'io.dbx.k8s', version: '0.1.2' }, null, 2) + '\n')
    const bumped = run(root)
    assert.equal(bumped.status, 'stale')
    assert.equal(bumped.version, '0.1.2')
    assert.equal(bumped.nextVersion, '0.1.4')

    assert.match(readFixtureFile(root, 'manifest.json'), /"version": "0\.1\.2"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
