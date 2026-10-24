import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfigSection, type ConfigSectionDefinition } from "@/pages/shared/configuration-page";
import {
  globalAppConfigService,
  type ExternalApiConfig,
  type ExternalApiStatus,
} from "@/platforms/app-config/service";

const section: ConfigSectionDefinition<ExternalApiConfig> = {
  title: "本机接口服务",
  description: "让电脑上的其他程序使用百度网盘下载功能。",
  fields: [
    {
      kind: "switch",
      key: "enabled",
      label: "开启接口服务",
      description: "开启后立即生效，并在下次启动应用时自动开启。",
      activeLabel: "已开启",
      inactiveLabel: "已关闭",
    },
    {
      key: "port",
      label: "服务端口",
      type: "number",
      min: 1,
      max: 65535,
    },
  ],
};

export function ExternalApiConfiguration() {
  const [config, setConfig] = useState<ExternalApiConfig>({
    enabled: false,
    port: "18439",
  });
  const [saved, setSaved] = useState(config);
  const [status, setStatus] = useState<ExternalApiStatus>({ running: false });
  const [busy, setBusy] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    globalAppConfigService
      .getExternalApiConfig()
      .then((result) => {
        if (disposed) return;
        setConfig(result.config);
        setSaved(result.config);
        setStatus(result.status);
      })
      .catch((error) => {
        if (!disposed) setLoadError(String(error));
      })
      .finally(() => {
        if (!disposed) setBusy(false);
      });
    const timer = setInterval(() => {
      void globalAppConfigService
        .getExternalApiStatus()
        .then((value) => {
          if (!disposed) setStatus(value);
        })
        .catch(() => undefined);
    }, 3_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  const save = async (next: ExternalApiConfig) => {
    setBusy(true);
    try {
      const result = await globalAppConfigService.saveExternalApiConfig(next);
      setConfig(result.config);
      setSaved(result.config);
      setStatus(result.status);
      toast.success(result.config.enabled ? "接口服务已启动" : "接口服务已关闭");
    } catch (error) {
      toast.error("接口设置失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label}已复制`);
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };
  const hasChanges = JSON.stringify(config) !== JSON.stringify(saved);
  return (
    <fieldset disabled={busy || Boolean(loadError)} className="min-w-0">
      <ConfigSection
        config={config}
        section={section}
        fields={section.fields}
        onChange={(key, value) => {
          if (key === "enabled") void save({ ...(value === "true" ? config : saved), enabled: value === "true" });
          else setConfig((current) => ({ ...current, [key]: value }));
        }}
        footer={
          <div className="flex flex-col gap-3">
            <div role="status" aria-live="polite" className="break-words text-sm">
              {loadError ? (
                `配置读取失败：${loadError}`
              ) : status.error ? (
                <span className="text-destructive">{status.error}</span>
              ) : status.running ? (
                `运行中 · ${status.baseUrl}`
              ) : config.enabled ? (
                "服务未运行"
              ) : (
                "服务已关闭"
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              关闭服务后，已提交的下载任务继续执行。修改端口后，请点击“应用设置”。
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!status.baseUrl}
                onClick={() => void copy(status.baseUrl!, "接口地址")}
              >
                复制接口地址
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!hasChanges && (!config.enabled || status.running)}
                onClick={() => void save(config)}
              >
                应用设置
              </Button>
            </div>
          </div>
        }
      />
    </fieldset>
  );
}
