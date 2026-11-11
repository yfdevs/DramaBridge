import { useYoutubeRuntime } from "./use-youtube-runtime";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ConfigurationPageFrame, ConfigPanelSection } from "@/pages/shared/configuration-page";
import { CheckCircle, DangerTriangle } from "@mynaui/icons-react";
import {
  youtubeService,
  type YoutubeConfig,
  type YoutubeConfigResult,
  type YoutubeEnvironment,
} from "@/platforms/youtube-drama/service";
import { YoutubeFeedback } from "./shared";

function ConfigRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3 py-4 @min-[620px]:grid-cols-[minmax(0,1fr)_minmax(280px,1fr)] @min-[620px]:gap-8">
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-xs leading-5 text-muted-foreground">{description}</p>}
      </div>
      <div className="min-w-0 space-y-2">{children}</div>
    </div>
  );
}
export function YoutubeConfigurationPage() {
  const model = useYoutubeRuntime();
  const { status, locked, run, setNotice } = model;
  const [config, setConfig] = useState<YoutubeConfig>({
    pythonExecutable: "",
    proxy: "",
    paused: false,
    webPort: 18440,
  });
  const [saved, setSaved] = useState(config);
  const [proxyPort, setProxyPort] = useState("");
  const [savedPort, setSavedPort] = useState("");
  const [metadata, setMetadata] = useState<YoutubeConfigResult | null>(null);
  const [checked, setChecked] = useState<YoutubeEnvironment | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [environmentError, setEnvironmentError] = useState("");
  const [checkingEnvironment, setCheckingEnvironment] = useState(false);
  const wasInstalling = useRef(false);
  useEffect(() => {
    const completed = wasInstalling.current && !status.installing && !status.error;
    wasInstalling.current = status.installing;
    if (loading || status.installing || status.running) {
      setCheckingEnvironment(false);
      if (status.running) setEnvironmentError("");
      return;
    }
    let active = true;
    setCheckingEnvironment(true);
    setEnvironmentError("");
    void youtubeService
      .checkEnvironment()
      .then((result) => {
        if (!active) return;
        setChecked(result);
        if (completed) setNotice(result.ready ? "环境已就绪" : "依赖准备结束，请查看检查结果");
      })
      .catch((error) => {
        if (active) setEnvironmentError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setCheckingEnvironment(false);
      });
    return () => {
      active = false;
    };
  }, [
    loading,
    status.installing,
    status.running,
    status.error,
    saved.pythonExecutable,
    metadata?.dataDirectory,
    setNotice,
  ]);
  const changed = JSON.stringify(config) !== JSON.stringify(saved) || proxyPort !== savedPort;
  const disabled = loading || locked || status.running;
  const apply = (result: YoutubeConfigResult) => {
    setConfig(result.config);
    setSaved(result.config);
    setMetadata(result);
    const port = result.config.proxy ? new URL(result.config.proxy).port || "80" : "";
    setProxyPort(port);
    setSavedPort(port);
  };
  useEffect(() => {
    let alive = true;
    void youtubeService
      .config()
      .then((result) => {
        if (alive) apply(result);
      })
      .catch((error) => {
        if (alive) setLoadError(String(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const persist = async () => {
    if (
      proxyPort &&
      (!/^\d+$/.test(proxyPort) || Number(proxyPort) < 1 || Number(proxyPort) > 65535)
    )
      throw new Error("端口应为 1–65535");
    const result = await youtubeService.saveConfig({
      ...config,
      proxy: proxyPort ? `http://127.0.0.1:${Number(proxyPort)}` : "",
    });
    apply(result);
  };
  const environment = status.running ? model.environment : checked;
  return (
    <ConfigurationPageFrame
      title="YouTube 配置"
      hasChanges={changed}
      loading={loading || model.busy}
      saveDisabled={locked || status.running || Boolean(loadError)}
      restartRequired={false}
      onDiscard={() => {
        setConfig(saved);
        setProxyPort(savedPort);
      }}
      onSave={() =>
        void run(async () => {
          await persist();
          setNotice("配置已保存");
        })
      }
    >
      <YoutubeFeedback model={model} />
      {loadError && (
        <p role="alert" className="text-xs text-destructive">
          {loadError}
        </p>
      )}
      {status.running && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2.5 text-xs">
          <span>请先停止服务，再修改配置</span>
          <Button
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => void run(youtubeService.stop)}
          >
            停止服务
          </Button>
        </div>
      )}
      <ConfigPanelSection title="运行环境" description="">
        <ConfigRow title="运行依赖" description="自动安装并管理 Python 和视频处理依赖">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  if (changed) await persist();
                  await youtubeService.install();
                  setChecked(null);
                  setNotice("环境安装中，完成后会自动检查，可查看日志");
                })
              }
            >
              {status.installing ? "安装中…" : environment?.ready ? "重新安装依赖" : "安装依赖"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={loading || locked || checkingEnvironment}
              onClick={() =>
                void run(async () => {
                  if (changed && !status.running) await persist();
                  setEnvironmentError("");
                  setChecked(await youtubeService.checkEnvironment());
                })
              }
            >
              {checkingEnvironment ? "检查环境中…" : changed ? "保存并检查" : "检查环境"}
            </Button>
            <Button size="sm" variant="ghost" render={<Link to="/youtube-drama/logs" />}>
              查看日志
            </Button>
          </div>
          {status.installing && (
            <p role="status" className="text-xs text-muted-foreground">
              {status.installStage || "正在准备环境…"}
            </p>
          )}
          {environmentError && (
            <p role="alert" className="text-xs leading-5 text-destructive">
              环境检查未完成：{environmentError}
            </p>
          )}
          {environment ? (
            <div aria-label="环境检查结果" className="space-y-3 rounded-lg bg-muted/40 p-3">
              <div className="flex items-center gap-2 text-xs font-medium">
                {environment.ready ? (
                  <CheckCircle className="size-4 text-[var(--config-success)]" />
                ) : (
                  <DangerTriangle className="size-4 text-[var(--config-warning)]" />
                )}
                {environment.ready ? "环境可用" : "环境未就绪"}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <span>Python {environment.python}</span>
                <span
                  className={environment.compatible ? "text-muted-foreground" : "text-destructive"}
                >
                  {environment.compatible ? "版本可用" : "需要 Python 3.10 以上"}
                </span>
                {Object.entries({
                  ...environment.modules,
                  FFmpeg: environment.ffmpeg,
                  FFprobe: environment.ffprobe,
                }).map(([name, ready]) => (
                  <div key={name} className="col-span-2 flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">
                      {{
                        demucs: "人声分离",
                        numpy: "音频计算",
                        googleapiclient: "YouTube 上传",
                        google_auth_oauthlib: "Google 授权",
                        socks: "代理连接",
                        FFmpeg: "视频处理",
                        FFprobe: "视频检测",
                      }[name] ?? name}
                    </span>
                    <Badge
                      variant="secondary"
                      className={ready ? "text-xs" : "text-xs text-[var(--config-warning)]"}
                    >
                      {ready ? "可用" : "未检测到"}
                    </Badge>
                  </div>
                ))}
              </div>
              {environment.executable && (
                <p className="break-all text-xs leading-5 text-muted-foreground">
                  当前 Python：{environment.executable}
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              {checkingEnvironment
                ? "正在检查运行环境…"
                : environmentError
                  ? "可重新检查或查看日志"
                  : "尚未检查运行环境"}
            </p>
          )}
        </ConfigRow>
      </ConfigPanelSection>
      <ConfigPanelSection title="网络" description="">
        <ConfigRow
          title="本机代理端口"
          description="用于 Google 授权和视频上传，不使用代理时留空"
        >
          <Input
            className="h-7 rounded-md"
            aria-label="YouTube 代理端口"
            disabled={disabled}
            type="number"
            min={1}
            max={65535}
            value={proxyPort}
            onChange={(e) => setProxyPort(e.target.value)}
            placeholder="7897"
          />
        </ConfigRow>
      </ConfigPanelSection>
      <ConfigPanelSection title="Web 访问" description="服务启动后，可在浏览器添加任务和管理账号">
        <ConfigRow title="Web 端口">
          <Input
            className="h-7 rounded-md"
            aria-label="Web 端口"
            type="number"
            min={1}
            max={65535}
            disabled={disabled}
            value={config.webPort}
            onChange={(event) => setConfig({ ...config, webPort: Number(event.target.value) })}
          />
        </ConfigRow>
        {status.webUrls?.length ? (
          <ConfigRow title="访问地址">
            <div className="grid gap-2">
              {status.webUrls.map((url) => (
                <div key={url} className="flex flex-wrap items-center gap-2">
                  <code className="break-all text-xs">{url}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void run(() => youtubeService.openWeb(url))}
                  >
                    打开
                  </Button>
                </div>
              ))}
            </div>
          </ConfigRow>
        ) : null}
      </ConfigPanelSection>
      <ConfigPanelSection title="Google 凭据" description="多个账号共用一份 Google 客户端凭据">
        <ConfigRow title="凭据文件" description="client_secret.json">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{metadata?.credentialsImported ? "已导入" : "未导入"}</Badge>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  if ((await youtubeService.importCredentials())?.imported) {
                    setMetadata(await youtubeService.config());
                    setNotice("凭据已导入，请到账号管理授权");
                  }
                })
              }
            >
              {metadata?.credentialsImported ? "更换凭据" : "导入凭据"}
            </Button>
            <Button size="sm" variant="ghost" render={<Link to="/youtube-drama/accounts" />}>
              管理账号
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            在 Google Cloud 启用 YouTube Data API v3，创建“桌面应用”凭据。
            <a
              href="https://console.cloud.google.com/auth/audience"
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 text-foreground underline underline-offset-4 hover:text-foreground/80"
              onClick={(event) => {
                event.preventDefault();
                void run(youtubeService.openTestUsers);
              }}
            >
              添加测试用户
            </a>
          </p>
        </ConfigRow>
      </ConfigPanelSection>
    </ConfigurationPageFrame>
  );
}
