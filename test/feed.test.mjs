// Feed parsing against a real capture of the nightly channel
// (test/fixtures/nightly.yml, downloaded 2026-11-15 from the feed the host
// itself reads). The YAML subset the updater needs is small; these cases pin
// every field it consumes plus the "incomplete feed" behavior it relies on to
// refuse an install.
import { readFileSync } from 'node:fs'
import { test, done, assert } from './helpers.mjs'
import { parseFeed } from '../lib/index.js'

const fixture = readFileSync(new URL('./fixtures/nightly.yml', import.meta.url), 'utf8')

test('parses version, release date, installer URL, size and sha512', () => {
  const feed = parseFeed(fixture)
  assert.equal(feed.version, '0.2.2-rc.3')
  assert.equal(feed.releaseDate, '2026-11-13T07:31:42.937Z')
  assert.equal(feed.size, 299595752)
  assert.match(feed.url, /^https:\/\/\S+deepseek-harness-0\.2\.2-rc\.3-win-x64\.exe$/)
  assert.equal(feed.sha512, 'GiJf8kx+C7eoiZ0xQSYBcTyh5xmXQl+vh63U6uSm963McK1AkMgB8PydzuekWdUY7hyURvhVMHANM4pn+tCKzQ==')
})

test('accepts a folded scalar for the checksum', () => {
  const digest = 'A'.repeat(44)
  const feed = parseFeed(['version: 1.2.3', 'path: https://example.com/setup.exe', 'sha512: >-', `  ${digest}`].join('\n'))
  assert.equal(feed.version, '1.2.3')
  assert.equal(feed.sha512, digest)
})

test('a checksum too short to be base64 sha512 is ignored', () => {
  const feed = parseFeed(['version: 1.2.3', 'path: https://example.com/setup.exe', 'sha512: AAAA'].join('\n'))
  assert.equal(feed.sha512, undefined)
})

test('a feed without a version is rejected', () => {
  assert.equal(parseFeed('path: https://example.com/setup.exe'), undefined)
})

test('a feed without an installer URL is rejected', () => {
  assert.equal(parseFeed('version: 1.2.3\nsize: 12'), undefined)
})

test('empty or unrelated text is rejected', () => {
  assert.equal(parseFeed(''), undefined)
  assert.equal(parseFeed('<html>maintenance</html>'), undefined)
})

test('missing optional fields do not break parsing', () => {
  const feed = parseFeed('version: 1.2.3\npath: https://example.com/deepseek-harness-setup.exe')
  assert.equal(feed.version, '1.2.3')
  assert.equal(feed.size, 0)
  assert.equal(feed.releaseDate, undefined)
  assert.equal(feed.sha512, undefined)
})

done('feed')
