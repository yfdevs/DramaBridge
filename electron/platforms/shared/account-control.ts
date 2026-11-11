import { trpcIpc as ipcMain } from "../../ipc";
import { assertGlobalDirectoriesConfigured } from "../../global-app-config";
import type { RuntimeController } from "./runtime-controller";
import { accountIds } from "./account-runtime-group";

type Runtime = { stop(): Promise<void> };
type AccountControl = {
  addAccount(id: string): Promise<void>;
  setAccountPaused(id: string, paused: boolean): void;
};
export function registerAccountControl<T extends Runtime>({
  platform,
  controller,
  start,
  status,
  onStarted,
}: {
  platform: string;
  controller: RuntimeController<T>;
  start: (ids: string[]) => Promise<T>;
  status: () => unknown;
  onStarted?: (id: string) => void;
}) {
  ipcMain.handle(`${platform}:account:start`, async (_event, value: unknown) => {
    const [id] = accountIds([value]);
    assertGlobalDirectoriesConfigured();
    const runtime = await controller.resolveStarting();
    const active = runtime ?? (await controller.start(() => start([id!])));
    // A second account request may join an in-flight service start. Always
    // ensure its own account is present after the shared start completes.
    await (active as T & AccountControl).addAccount(id!);
    onStarted?.(id!);
    return status();
  });
  ipcMain.handle(`${platform}:account:pause`, async (_event, value: unknown, paused: unknown) => {
    const [id] = accountIds([value]);
    if (typeof paused !== "boolean") throw new Error("暂停状态无效");
    const runtime = await controller.resolveStarting();
    if (!runtime) throw new Error("请先启动该账号");
    (runtime as T & AccountControl).setAccountPaused(id!, paused);
    return status();
  });
}
