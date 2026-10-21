import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMainInvokeEvent } from 'electron'

import { invokeRegisteredHandler, registeredIpcChannels, trpcIpc } from './registry'

test('registers and invokes a typed IPC procedure', async () => {
  const channel = 'test:ipc:sum'
  trpcIpc.removeHandler(channel)
  trpcIpc.handle(channel, (_event, left: number, right: number) => left + right)

  assert.ok(registeredIpcChannels().includes(channel))
  assert.equal(
    await invokeRegisteredHandler({} as IpcMainInvokeEvent, channel, [2, 3]),
    5,
  )

  trpcIpc.removeHandler(channel)
})

test('rejects duplicate and unknown IPC procedures', async () => {
  const channel = 'test:ipc:duplicate'
  trpcIpc.removeHandler(channel)
  trpcIpc.handle(channel, () => 'ready')

  assert.throws(() => trpcIpc.handle(channel, () => 'duplicate'), /重复注册/)
  trpcIpc.removeHandler(channel)
  await assert.rejects(
    async () => invokeRegisteredHandler({} as IpcMainInvokeEvent, channel, []),
    /未注册/,
  )
})
