import assert from 'node:assert/strict'
import test from 'node:test'

import { numberText } from './config'

test('keeps a valid numeric configuration value', () => {
  assert.equal(numberText(' 12.5 ', '3', 1, 20), '12.5')
})

test('falls back for empty, out-of-range, or non-numeric values', () => {
  assert.equal(numberText('', '3', 1), '3')
  assert.equal(numberText('0', '3', 1), '3')
  assert.equal(numberText('invalid', '3', 1), '3')
})

test('validates integer-only settings without silently truncating them', () => {
  assert.equal(numberText('4', '3', 0, 20, true), '4')
  assert.equal(numberText('4.5', '3', 0, 20, true), '3')
})
