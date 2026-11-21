/** Per-account scheduling; persisted tasks remain the source of truth. */
export class PinduoduoUploadQueue {
  private nextSyncAt: number;
  private emptyChecked = false;
  private recovered = false;
  nextDelayMs: number;

  constructor(private intervalMs: number, private now = Date.now) {
    this.nextSyncAt = now() + intervalMs;
    this.nextDelayMs = intervalMs;
  }

  async run<T>(actions: {
    recover: () => Promise<unknown>;
    read: () => Promise<T[]>;
    sync: () => Promise<unknown>;
    process: (record: T) => Promise<boolean>;
    key: (record: T) => string | number;
    signal?: AbortSignal;
  }): Promise<number> {
    try {
      return await this.runCycle(actions);
    } catch (error) {
      // A failed cloud write can leave a task in an in-progress state. Recover
      // checkpoints before selecting work again, including uncertain publishes.
      this.recovered = false;
      this.nextDelayMs = 15_000;
      throw error;
    }
  }

  private async runCycle<T>(actions: {
    recover: () => Promise<unknown>;
    read: () => Promise<T[]>;
    sync: () => Promise<unknown>;
    process: (record: T) => Promise<boolean>;
    key: (record: T) => string | number;
    signal?: AbortSignal;
  }): Promise<number> {
    const check = () => actions.signal?.throwIfAborted();
    const sync = async () => {
      check();
      // Failed reads also observe the interval; never spin on an empty queue.
      this.nextSyncAt = this.now() + this.intervalMs;
      this.nextDelayMs = Math.max(1_000, this.intervalMs);
      await actions.sync();
    };
    check();
    this.nextDelayMs = Math.max(1_000, this.nextSyncAt - this.now());
    if (!this.recovered) { await actions.recover(); this.recovered = true; }
    let records = await actions.read();
    if (records.length) this.emptyChecked = false;
    if (this.now() >= this.nextSyncAt || (!records.length && !this.emptyChecked)) {
      await sync();
      records = await actions.read();
      this.emptyChecked = !records.length;
    }
    let uploaded = 0;
    const attempted = new Set<string | number>();
    for (const record of records) {
      check();
      if (this.now() >= this.nextSyncAt) await sync();
      attempted.add(actions.key(record));
      if (await actions.process(record)) uploaded++;
    }
    check();
    const remaining = await actions.read();
    if (remaining.some(record => !attempted.has(actions.key(record)))) {
      this.nextDelayMs = 1_000;
      return uploaded;
    }
    if (!remaining.length && !this.emptyChecked) {
      await sync();
      this.emptyChecked = true;
      const next = await actions.read();
      if (next.length) {
        this.emptyChecked = false;
        this.nextDelayMs = 1_000;
        return uploaded;
      }
    }
    this.nextDelayMs = Math.max(1_000, this.nextSyncAt - this.now());
    return uploaded;
  }
}
