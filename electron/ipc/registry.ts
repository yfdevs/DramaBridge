import type { IpcMainInvokeEvent } from 'electron'
import { EventEmitter } from 'node:events'

type RegisteredHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown

const handlers = new Map<string, RegisteredHandler>()
const eventBus = new EventEmitter()
eventBus.setMaxListeners(100)

function handle<Args extends unknown[], Result>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
) {
  if (handlers.has(channel)) {
    throw new Error(`重复注册 IPC 过程：${channel}`)
  }

  handlers.set(channel, handler as RegisteredHandler)
}

function removeHandler(channel: string) {
  handlers.delete(channel)
}

export const trpcIpc = {
  handle,
  removeHandler,
}

export function invokeRegisteredHandler(
  event: IpcMainInvokeEvent,
  channel: string,
  args: unknown[],
) {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`未注册 IPC 过程：${channel}`)
  }

  return handler(event, ...args)
}

export function registeredIpcChannels() {
  return [...handlers.keys()].sort()
}

export function emitIpcEvent(channel: string, ...args: unknown[]) {
  eventBus.emit(channel, args)
}

export function subscribeIpcEvent(channel: string, listener: (args: unknown[]) => void) {
  eventBus.on(channel, listener)
  return () => eventBus.off(channel, listener)
}
