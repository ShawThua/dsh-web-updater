// Minimal assertion harness: no dependencies, one line per case, non-zero exit
// on the first failure. Each test file prints its own summary so CI logs show
// which half failed.
import assert from 'node:assert/strict'

let passed = 0

export function test(name, fn) {
  try {
    fn()
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
  passed += 1
  console.log(`ok - ${name}`)
}

export function done(label) {
  console.log(`${label}: ${passed} cases passed`)
}

export { assert }
