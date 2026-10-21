const runtimeStopGracePeriodMs = 5_000

class RuntimeStartCancelledError extends Error {
  constructor() {
    super('Runtime start was cancelled')
    this.name = 'RuntimeStartCancelledError'
  }
}

type RuntimeStopResult =
  | { state: 'stopped' }
  | { state: 'failed'; error: unknown }
  | { state: 'timeout' }

async function waitForRuntimeStop(stopPromise: Promise<void>): Promise<RuntimeStopResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const result = await Promise.race<RuntimeStopResult>([
    stopPromise.then(
      () => ({ state: 'stopped' }),
      (error: unknown) => ({ state: 'failed', error }),
    ),
    new Promise<RuntimeStopResult>((resolve) => {
      timeout = setTimeout(() => resolve({ state: 'timeout' }), runtimeStopGracePeriodMs)
    }),
  ])

  if (timeout) clearTimeout(timeout)
  return result
}

export class RuntimeController<TRuntime extends { stop: () => Promise<void> }> {
  private runtime: TRuntime | null = null
  private runtimeStartedAt: number | null = null
  private starting: Promise<TRuntime> | null = null
  private stopping: Promise<void> | null = null

  get startedAt() {
    return this.runtime ? this.runtimeStartedAt : null
  }

  get current() {
    return this.runtime
  }

  get running() {
    return this.runtime !== null
  }

  get startingPromise() {
    return this.starting
  }

  async start(factory: () => Promise<TRuntime>) {
    if (this.runtime) return this.runtime

    if (this.stopping) {
      const stopResult = await waitForRuntimeStop(this.stopping)
      if (stopResult.state === 'failed') throw stopResult.error
    }

    if (!this.starting) {
      const startOperation: Promise<TRuntime> = factory().then(async (runtime) => {
        // stopInBackground can invalidate an in-flight start. Never publish the
        // late runtime after shutdown; clean it up as soon as creation finishes.
        if (this.starting !== startOperation) {
          await runtime.stop()
          throw new RuntimeStartCancelledError()
        }
        this.runtime = runtime
        this.runtimeStartedAt = Date.now()
        return runtime
      })
      this.starting = startOperation
    }

    const startOperation = this.starting
    try {
      return await startOperation
    } finally {
      if (this.starting === startOperation) this.starting = null
    }
  }

  async resolveStarting() {
    if (this.starting) await this.starting

    return this.runtime
  }

  async replace(factory: () => Promise<TRuntime>) {
    await this.stop()
    return this.start(factory)
  }

  async stop() {
    try {
      await this.resolveStarting()
    } catch {
      this.starting = null
    }

    const runtime = this.runtime
    this.runtime = null
    this.runtimeStartedAt = null

    if (!runtime) {
      if (this.stopping) await waitForRuntimeStop(this.stopping)
      return
    }

    const stopPromise = Promise.resolve().then(() => runtime.stop())
    this.stopping = stopPromise
    void stopPromise.then(
      () => {
        if (this.stopping === stopPromise) this.stopping = null
      },
      (error: unknown) => {
        if (this.stopping === stopPromise) this.stopping = null
        console.error('[runtime-controller] background runtime stop failed', error)
      },
    )

    const result = await waitForRuntimeStop(stopPromise)
    if (result.state === 'failed') throw result.error
    if (result.state === 'timeout') {
      console.warn(
        `[runtime-controller] runtime cleanup exceeded ${runtimeStopGracePeriodMs}ms; continuing in background`,
      )
    }
  }

  stopInBackground() {
    const runtime = this.runtime
    this.runtime = null
    this.runtimeStartedAt = null
    const starting = this.starting
    this.starting = null
    if (starting) {
      void starting.catch((error: unknown) => {
        if (!(error instanceof RuntimeStartCancelledError)) {
          console.error('[runtime-controller] background runtime start failed', error)
        }
      })
    }
    if (runtime) {
      void runtime.stop().catch((error: unknown) => {
        console.error('[runtime-controller] background runtime stop failed', error)
      })
    }
  }
}
