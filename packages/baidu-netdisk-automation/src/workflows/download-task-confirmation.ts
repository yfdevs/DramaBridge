/** Queue absence is trusted only after successful inspections. Native failures
 * must propagate so the caller cannot replay an uncertain submission.
 */
export async function confirmSingleFileDownload(runtime: {
  inspect: () => Promise<boolean>;
  localComplete: () => Promise<boolean>;
  wait: () => Promise<void>;
}): Promise<boolean> {
  for (let probe = 0; probe < 3; probe += 1) {
    await runtime.wait();
    try {
      if (await runtime.inspect()) return true;
    } catch (error) {
      // A native queue read can fail after a fast download has already left it.
      // Exact local validation is independent positive evidence, never absence.
      if (await runtime.localComplete()) return true;
      throw error;
    }
    if (await runtime.localComplete()) return true;
  }
  return false;
}
