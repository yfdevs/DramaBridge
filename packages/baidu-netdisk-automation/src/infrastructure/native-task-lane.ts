// The installed client keeps native read callbacks in module-level variables.
// Serialize our reads and controls per client, independent of long cloud-transfer
// operations. This cannot serialize the client's own UI; read timeouts stay unknown.
const tails = new Map<number, Promise<void>>();

export function runNativeTaskOperationExclusive<T>(port: number, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(port) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(() => undefined, () => undefined);
  tails.set(port, tail);
  void tail.then(() => {
    if (tails.get(port) === tail) tails.delete(port);
  });
  return current;
}
