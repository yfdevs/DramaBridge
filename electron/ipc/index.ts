import { createIPCHandler } from 'electron-trpc/main'
import type { IpcMainInvokeEvent } from 'electron'

import { electronIpcRouter } from './router'

let initialized = false

export function initializeTrpcIpc() {
  if (initialized) {
    return
  }

  createIPCHandler({
    router: electronIpcRouter,
    createContext: async ({ event }) => ({ event: event as IpcMainInvokeEvent }),
  })
  initialized = true
}

export { trpcIpc } from './registry'
