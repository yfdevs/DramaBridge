import { createHash, randomUUID } from "node:crypto";
import { uuid } from "systeminformation";

// Never expose the OS identifier itself to the server. The process suffix also
// isolates two processes on the same computer and old reports after a restart.
export function buildTaobaoWorkerId(machineIdentifier: string, processId = randomUUID()) {
  if (!machineIdentifier.trim()) throw new Error("淘宝执行器缺少电脑标识");
  const machineHash = createHash("sha256").update(`dramabridge:taobao:${machineIdentifier.trim().toLowerCase()}`).digest("hex").slice(0, 32);
  return `taobao-${machineHash}-${processId}`;
}

let identity: Promise<string> | undefined;
export function getTaobaoWorkerId(fallbackInstallationId: () => string) {
  return identity ??= (async () => {
    const identifiers = await uuid().catch(() => undefined);
    const os = identifiers?.os?.trim();
    // All-zero/default BIOS UUIDs are common, so use OS MachineGuid/machine-id.
    const machineId = os && !/^(?:0+|unknown|default|none|undefined)$/i.test(os.replace(/-/g, "")) ? os : fallbackInstallationId();
    return buildTaobaoWorkerId(machineId);
  })();
}
