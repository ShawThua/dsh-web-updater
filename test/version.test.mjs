// Version comparison: the nightly channel ships release candidates, so the
// ordering rules for `-rc.N` matter as much as plain semver ordering.
import { test, done, assert } from './helpers.mjs'
import { compareVersions } from '../lib/index.js'

test('later release candidate is newer', () => {
  assert.equal(compareVersions('0.2.2-rc.3', '0.2.2-rc.1'), 1)
  assert.equal(compareVersions('0.2.2-rc.1', '0.2.2-rc.3'), -1)
})

test('release candidate numbering is numeric, not lexical', () => {
  assert.equal(compareVersions('0.2.2-rc.10', '0.2.2-rc.9'), 1)
})

test('identical versions compare equal', () => {
  assert.equal(compareVersions('0.2.2-rc.3', '0.2.2-rc.3'), 0)
  assert.equal(compareVersions('0.2.2', '0.2.2'), 0)
})

test('a final release beats every release candidate of the same version', () => {
  assert.equal(compareVersions('0.2.2', '0.2.2-rc.3'), 1)
  assert.equal(compareVersions('0.2.2-rc.3', '0.2.2'), -1)
})

test('numeric fields are compared before the prerelease tag', () => {
  assert.equal(compareVersions('0.2.1', '0.2.2-rc.1'), -1)
  assert.equal(compareVersions('0.3.0-rc.1', '0.2.9'), 1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
})

test('whitespace around the version is ignored', () => {
  assert.equal(compareVersions(' 0.2.2-rc.3\n', '0.2.2-rc.3'), 0)
})

test('unparsable versions still yield a stable answer instead of throwing', () => {
  assert.equal(compareVersions('', ''), 0)
  assert.equal(compareVersions('(unknown)', '(unknown)'), 0)
  assert.equal(compareVersions('garbage', 'x'), -1)
  assert.equal(typeof compareVersions(undefined, '0.2.2'), 'number')
})

done('version')
