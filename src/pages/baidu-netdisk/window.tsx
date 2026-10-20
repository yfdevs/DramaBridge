import { useEffect, useState } from "react";
import { Folder } from "@mynaui/icons-react";

import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  controlBaiduNetdiskCdp,
  getBaiduNetdiskConfig,
  getBaiduNetdiskStatus,
  saveBaiduNetdiskConfig,
  selectBaiduNetdiskExecutable,
  type BaiduNetdiskCdpStatus,
} from "@/platforms/baidu-netdisk/service";

type BaiduAction = "start" | "restart";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function baiduNetdiskSummary(status: BaiduNetdiskCdpStatus | null, error: string | null) {
  if (error) return "连接失败";
  if (!status) return "正在检查";
  if (status.ready) return "已连接";
  if (!status.appRunning) return "客户端未启动";
  if (!status.cdpRunning) return "需要重新连接";
  return "暂时无法连接";
}

export function BaiduNetdiskPanel() {
  const [status, setStatus] = useState<BaiduNetdiskCdpStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [actionPending, setActionPending] = useState<BaiduAction | null>(null);
  const [installPath, setInstallPath] = useState("");
  const [installPathPending, setInstallPathPending] = useState<"select" | "reset" | null>(null);
  const [installPathMessage, setInstallPathMessage] = useState<string | null>(null);
  const [installPathError, setInstallPathError] = useState<string | null>(null);

  const summary = baiduNetdiskSummary(status, statusError);
  const shouldRestart = Boolean(status?.appRunning);
  const showClientSetup = Boolean(statusError || (status && !status.ready));

  const refreshStatus = async () => {
    setStatusRefreshing(true);

    try {
      const nextStatus = await getBaiduNetdiskStatus();
      setStatus(nextStatus);
      setStatusError(null);
    } catch (error) {
      setStatusError(errorMessage(error));
    } finally {
      setStatusRefreshing(false);
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    let disposed = false;

    void (async () => {
      try {
        const result = await getBaiduNetdiskConfig();
        const nextInstallPath = result.config.executablePath.trim();

        if (!disposed) {
          setInstallPath(nextInstallPath);
          setInstallPathError(null);
        }
      } catch (error) {
        if (!disposed) setInstallPathError(errorMessage(error));
      }
    })();

    return () => {
      disposed = true;
    };
  }, []);

  const handleSelectInstallPath = () => {
    void (async () => {
      setInstallPathPending("select");
      setInstallPathMessage(null);
      setInstallPathError(null);

      try {
        const result = await selectBaiduNetdiskExecutable();
        if (!result) return;
        const nextInstallPath = result.config.executablePath.trim();

        setInstallPath(nextInstallPath);
        setInstallPathMessage("启动文件已保存。");
        void refreshStatus();
      } catch (error) {
        setInstallPathError(errorMessage(error));
      } finally {
        setInstallPathPending(null);
      }
    })();
  };

  const handleResetInstallPath = () => {
    void (async () => {
      setInstallPathPending("reset");
      setInstallPathMessage(null);
      setInstallPathError(null);

      try {
        const result = await saveBaiduNetdiskConfig({ executablePath: "" });
        setInstallPath(result.config.executablePath.trim());
        setInstallPathMessage("已恢复默认自动查找。");
        void refreshStatus();
      } catch (error) {
        setInstallPathError(errorMessage(error));
      } finally {
        setInstallPathPending(null);
      }
    })();
  };

  const handleStart = (restart: boolean) => {
    void (async () => {
      setActionPending(restart ? "restart" : "start");
      setStatusError(null);

      try {
        const result = await controlBaiduNetdiskCdp(restart);
        setStatus(result.status);
      } catch (error) {
        setStatusError(errorMessage(error));
      } finally {
        setActionPending(null);
      }
    })();
  };

  return (
    <div className="bg-background">
      <div className="grid gap-2.5 p-3">
        <div className="flex min-h-8 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={`ml-0.5 size-2 shrink-0 rounded-full ring-2 ${
                status?.ready
                  ? "bg-emerald-500 ring-emerald-500/10"
                  : statusError || status
                    ? "bg-rose-500 ring-rose-500/10"
                    : "bg-muted-foreground/40 ring-muted-foreground/10"
              }`}
              aria-hidden="true"
            />
            <span className="sr-only">连接状态：</span>
            <span className="truncate text-xs font-medium">{summary}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={statusRefreshing || actionPending !== null}
              onClick={() => void refreshStatus()}
            >
              {statusRefreshing ? "检查中" : "检查"}
            </Button>
            {status ? (
              <Button
                type="button"
                size="xs"
                disabled={actionPending !== null || status.isWindows === false}
                onClick={() => handleStart(shouldRestart)}
              >
                {actionPending ? "连接中…" : shouldRestart ? "重启连接" : "启动并连接"}
              </Button>
            ) : null}
          </div>
        </div>

        {statusError ? (
          <div className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs leading-5 break-words text-destructive">
            {statusError}
          </div>
        ) : null}

        {showClientSetup ? (
          <div className="grid gap-1.5 border-t border-border/60 pt-2.5">
            <label htmlFor="baidu-netdisk-install-path" className="text-xs font-medium">
              百度网盘启动文件
            </label>
            <InputGroup className="h-8 rounded-lg">
              <InputGroupInput
                id="baidu-netdisk-install-path"
                value={installPath}
                readOnly
                title={installPath || undefined}
                placeholder="未找到百度网盘启动文件"
                className="text-xs md:text-xs"
                aria-invalid={Boolean(installPathError)}
              />
              <InputGroupAddon align="inline-end">
                {installPath ? (
                  <InputGroupButton
                    className="text-xs"
                    disabled={installPathPending !== null || actionPending !== null}
                    onClick={handleResetInstallPath}
                  >
                    {installPathPending === "reset" ? "恢复中" : "自动查找"}
                  </InputGroupButton>
                ) : null}
                <InputGroupButton
                  className="text-xs"
                  aria-label="选择百度网盘启动文件"
                  disabled={installPathPending !== null || actionPending !== null}
                  onClick={handleSelectInstallPath}
                >
                  <Folder aria-hidden="true" />
                  {installPathPending === "select" ? "选择中" : "选择文件"}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {installPathError || installPathMessage ? (
              <p
                className={`px-1 text-xs ${installPathError ? "text-destructive" : "text-muted-foreground"}`}
              >
                {installPathError || installPathMessage}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
