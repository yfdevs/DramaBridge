import { initTRPC } from '@trpc/server'
import type { IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'

import { invokeRegisteredHandler } from './registry'

type IpcContext = {
  event: IpcMainInvokeEvent
}

const trpc = initTRPC.context<IpcContext>().create()
const invokeInput = z.object({
  channel: z.string().trim().min(1),
  args: z.array(z.unknown()).default([]),
})

export const electronIpcRouter = trpc.router({
  invoke: trpc.procedure
    .input(invokeInput)
    .mutation(({ ctx, input }) => invokeRegisteredHandler(ctx.event, input.channel, input.args)),
})

export type ElectronIpcRouter = typeof electronIpcRouter
