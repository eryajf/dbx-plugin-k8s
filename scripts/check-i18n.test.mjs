import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkDirectory, validateLocale } from './check-i18n.mjs'

test('accepts reordered placeholders, markup, technical literals and valid emoji', () => {
  const source = { text: '<b>{{name}}</b>: {{count}} 🚀', kind: 'Pod' }
  const translated = { text: '{{count}}：<b>{{name}}</b> 🚀', kind: 'Pod' }
  assert.deepEqual(validateLocale(source, translated).errors, [])
})

test('rejects missing, extra and structurally different keys', () => {
  const result = validateLocale(
    { a: { b: 'Save' }, c: 'Cancel' },
    { a: '保存', d: '取消' }
  )
  assert.match(result.errors.join('\n'), /a: expected object/)
  assert.match(result.errors.join('\n'), /c: missing key/)
  assert.match(result.errors.join('\n'), /d: extra key/)
})

test('rejects a flattened dotted key in place of a nested object', () => {
  assert.ok(
    validateLocale({ a: { b: 'Save' } }, { 'a.b': '保存' }).errors.length
  )
})

test('validates placeholder multiplicity and format tokens', () => {
  const result = validateLocale(
    {
      a: '{{name}} {{name}} ${value}',
      b: '<strong>Save</strong>',
      c: '`kubectl` command',
    },
    { a: '{{name}} ${value}', b: '<b>保存</b>', c: 'kubectl 命令' }
  )
  assert.match(result.errors.join('\n'), /placeholder mismatch/)
  assert.match(result.errors.join('\n'), /markup mismatch/)
  assert.match(result.errors.join('\n'), /backtick mismatch/)
  assert.deepEqual(
    validateLocale({ a: 'Value < 10' }, { a: '值 < 10' }).errors,
    []
  )
})

test('rejects invalid Unicode and non-string leaves without rejecting emoji', () => {
  for (const value of ['坏\uFFFD', '\uD800', '\uDC00']) {
    assert.match(
      validateLocale({ a: 'Hello' }, { a: value }).errors.join('\n'),
      /invalid Unicode/
    )
  }
  assert.match(
    validateLocale({ a: 'Hello' }, { a: 1 }).errors.join('\n'),
    /expected string/
  )
  assert.deepEqual(validateLocale({ a: 'Hello' }, { a: '你好 👩‍💻' }).errors, [])
})

test('blocks untranslated text, including short labels', () => {
  assert.match(
    validateLocale({ a: 'Save' }, { a: 'Save' }).errors.join('\n'),
    /untranslated/
  )
  assert.match(
    validateLocale(
      { a: 'Unable to load resources' },
      { a: 'Unable to load resources' }
    ).errors.join('\n'),
    /untranslated/
  )
  assert.deepEqual(
    validateLocale({ a: 'Save' }, { a: 'Save' }, { source: true }).errors,
    []
  )
})

test('reports malformed JSON as a validation failure', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'dbx-i18n-test-'))
  try {
    writeFileSync(path.join(directory, 'en.json'), '{"save":"Save"}')
    writeFileSync(path.join(directory, 'es.json'), '{bad json')
    const result = checkDirectory(directory, { locales: ['en', 'es'] })
    assert.equal(result.ok, false)
    assert.match(result.results[1].errors[0], /invalid JSON/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('rejects Simplified-only characters in Traditional Chinese', () => {
  assert.match(
    validateLocale(
      { save: 'Save settings' },
      { save: '保存设置' },
      { locale: 'zh-TW' }
    ).errors.join('\n'),
    /Simplified-only/
  )
  assert.deepEqual(
    validateLocale(
      { save: 'Save settings' },
      { save: '儲存設定' },
      { locale: 'zh-TW' }
    ).errors,
    []
  )
})

test('preserves Kubernetes kinds and resource quantity examples', () => {
  assert.match(
    validateLocale(
      { resourceKind: { pod: 'Pod' } },
      { resourceKind: { pod: '豆莢' } }
    ).errors.join('\n'),
    /Kind must remain unchanged/
  )
  assert.match(
    validateLocale(
      { hint: 'For example 100m or 128Mi' },
      { hint: '例如 100 m 或 128Mi' }
    ).errors.join('\n'),
    /quantity example mismatch/
  )
})
