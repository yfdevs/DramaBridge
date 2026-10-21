import type { IpcMainInvokeEvent } from 'electron'

type RegisteredHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown

const handlers = new Map<string, RegisteredHandler>()

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
