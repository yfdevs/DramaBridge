type AccountStatus = { accountId: string; launched: boolean; paused?: boolean };
type Status = { running: boolean; accounts: AccountStatus[] };
type Runtime<S extends Status> = { getStatus(): S; stop(): Promise<void> };

export function accountIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((id) => typeof id !== "string" || !id.trim())
  )
    throw new Error("请选择有效的账号");
  return [...new Set(value as string[])];
}

// Each account owns its runtime. Adding or pausing a sibling never tears down
// browsers or interrupts already claimed work.
export async function createAccountRuntimeGroup<S extends Status>(
  input: unknown,
  factory: (id: string, canClaimTask: () => boolean) => Promise<Runtime<S>>,
) {
  const runtimes = new Map<string, Runtime<S>>();
  const paused = new Set<string>();
  const accountErrors: Record<string, string> = {};
  let stopped = false;
  let queue: Promise<unknown> = Promise.resolve();
  const addAccount = (id: string) => {
    accountIds([id]);
    const operation = queue.then(async () => {
      if (stopped) throw new Error("服务正在停止，请稍后重试");
      if (
        runtimes
          .get(id)
          ?.getStatus()
          .accounts.some((account) => account.accountId === id && account.launched)
      )
        return;
      const previous = runtimes.get(id);
      if (previous) await previous.stop();
      paused.delete(id);
      const runtime = await factory(id, () => !stopped && !paused.has(id));
      if (stopped) {
        await runtime.stop();
        throw new Error("服务已停止");
      }
      runtimes.set(id, runtime);
      delete accountErrors[id];
    });
    queue = operation.catch(() => undefined);
    return operation;
  };
  try {
    for (const id of accountIds(input)) {
      try {
        await addAccount(id);
      } catch (error) {
        accountErrors[id] = error instanceof Error ? error.message : String(error);
      }
    }
    if (!runtimes.size) throw new Error(Object.values(accountErrors).join("；"));
  } catch (error) {
    stopped = true;
    await Promise.allSettled([...runtimes.values()].map((runtime) => runtime.stop()));
    throw error;
  }
  return {
    addAccount,
    setAccountPaused(id: string, value: boolean) {
      if (
        stopped ||
        !runtimes
          .get(id)
          ?.getStatus()
          .accounts.some((account) => account.accountId === id && account.launched)
      )
        throw new Error("该账号尚未启动");
      if (value) paused.add(id);
      else paused.delete(id);
    },
    getStatus(): S {
      const statuses = [...runtimes.values()].map((runtime) => runtime.getStatus());
      const accounts = statuses
        .flatMap((status) => status.accounts)
        .map((account) => ({
          ...account,
          paused: account.launched && paused.has(account.accountId),
        }));
      return {
        ...statuses[0]!,
        running: !stopped && accounts.some((account) => account.launched),
        accounts,
        accountErrors,
      };
    },
    async stop() {
      stopped = true;
      await queue;
      await Promise.allSettled([...runtimes.values()].map((runtime) => runtime.stop()));
      paused.clear();
    },
  };
}
