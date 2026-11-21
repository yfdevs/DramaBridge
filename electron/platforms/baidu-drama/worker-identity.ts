import { createHash, randomUUID } from "node:crypto";
import { uuid } from "systeminformation";

export function buildBaiduWorkerId(machineIdentifier: string, processId = randomUUID()) {
  if (!machineIdentifier.trim()) throw new Error("百度执行器缺少电脑标识");
  const machineHash = createHash("sha256").update(`dramabridge:baidu:${machineIdentifier.trim().toLowerCase()}`).digest("hex").slice(0, 32);
  const workerId = `baidu-${machineHash}-${processId}`;
  if (workerId.length > 128) throw new Error("百度执行器标识超过128字符");
  return workerId;
}

let identity: Promise<string> | undefined;
export function getBaiduWorkerId(fallbackInstallationId: () => string) {
  return (identity ??= (async () => {
    const identifiers = await uuid().catch(() => undefined);
    const os = identifiers?.os?.trim();
    const machineId = os && !/^(?:0+|unknown|default|none|undefined)$/i.test(os.replace(/-/g, "")) ? os : fallbackInstallationId();
    return buildBaiduWorkerId(machineId);
  })());
}
