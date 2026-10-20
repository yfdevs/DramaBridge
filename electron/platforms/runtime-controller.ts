const runtimeStopGracePeriodMs = 5_000

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

    if (!this.starting) {
      this.starting = factory()
    }

    try {
      this.runtime = await this.starting
      this.runtimeStartedAt ??= Date.now()
      return this.runtime
    } finally {
      this.starting = null
    }
  }

  async resolveStarting() {
    if (this.starting) {
      this.runtime = await this.starting
      this.runtimeStartedAt ??= Date.now()
      this.starting = null
    }

    return this.runtime
  }

  async replace(factory: () => Promise<TRuntime>) {
    await this.stop()
    this.runtime = await factory()
    this.runtimeStartedAt = Date.now()
    return this.runtime
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
    this.starting = null
    if (runtime) {
      void runtime.stop().catch((error: unknown) => {
        console.error('[runtime-controller] background runtime stop failed', error)
      })
    }
  }
}
