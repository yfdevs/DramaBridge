import assert from 'node:assert/strict'
import test from 'node:test'

import { z } from 'zod'

test('uses the installed Zod 4 API', () => {
  const schema = z.object({ retries: z.number().int().nonnegative() })
  assert.deepEqual(schema.parse({ retries: 3 }), { retries: 3 })
  assert.equal(schema.safeParse({ retries: '3' }).success, false)
})
