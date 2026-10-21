import { initTRPC } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import type { IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'

import { invokeRegisteredHandler, subscribeIpcEvent } from './registry'

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
  events: trpc.procedure
    .input(z.object({ channel: z.string().trim().min(1) }))
    .subscription(({ input }) => observable<unknown[]>((emit) => {
      return subscribeIpcEvent(input.channel, (args) => emit.next(args))
    })),
})

export type ElectronIpcRouter = typeof electronIpcRouter
