import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMainInvokeEvent } from 'electron'

import {
  emitIpcEvent,
  invokeRegisteredHandler,
  registeredIpcChannels,
  subscribeIpcEvent,
  trpcIpc,
} from './registry'
import { electronIpcRouter } from './router'

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

test('routes a validated Zod 4 envelope through tRPC 10', async () => {
  const channel = 'test:ipc:trpc'
  const event = {} as IpcMainInvokeEvent
  trpcIpc.removeHandler(channel)
  trpcIpc.handle(channel, (_event, value: string) => value.toUpperCase())

  const caller = electronIpcRouter.createCaller({ event })
  assert.equal(await caller.invoke({ channel, args: ['ready'] }), 'READY')
  await assert.rejects(
    async () => caller.invoke({ channel: '', args: [] }),
  )

  trpcIpc.removeHandler(channel)
})

test('publishes and unsubscribes application events', () => {
  const received: unknown[][] = []
  const unsubscribe = subscribeIpcEvent('test:event', (args) => received.push(args))

  emitIpcEvent('test:event', 'ready', 2)
  unsubscribe()
  emitIpcEvent('test:event', 'ignored')

  assert.deepEqual(received, [['ready', 2]])
})
