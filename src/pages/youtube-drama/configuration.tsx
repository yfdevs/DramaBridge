import { useYoutubeRuntime } from "./use-youtube-runtime";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import { Badge } from "@/components/ui/badge";
import { ConfigurationPageFrame, ConfigPanelSection } from "@/pages/shared/configuration-page";
import { Folder, CheckCircle, DangerTriangle } from "@mynaui/icons-react";
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
    <div className="grid gap-3 border-b py-4 last:border-0 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-6">
      <div className="space-y-1">
        <p className="text-xs font-medium">{title}</p>
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
  const wasInstalling = useRef(false);
  useEffect(() => {
    const completed = wasInstalling.current && !status.installing && !status.error;
    wasInstalling.current = status.installing;
    if (!completed) return;
    let active = true;
    void youtubeService
      .checkEnvironment()
      .then((result) => {
        if (!active) return;
        setChecked(result);
        setNotice(result.ready ? "环境已就绪" : "依赖已安装，请查看检查结果");
      })
      .catch((error) => {
        if (active) setLoadError(String(error));
      });
    return () => {
      active = false;
    };
  }, [status.installing, status.error, setNotice]);
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
    setChecked(null);
  };
  const environment = status.running ? model.environment : checked;
  return (
    <ConfigurationPageFrame
      title="YouTube 配置"
      hasChanges={changed}
      loading={disabled}
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
          <span>请先停止服务，再修改配置。</span>
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
        <ConfigRow title="Python 启动文件" description="可选；不选则自动准备 Python 3.12。">
          <InputGroup>
            <InputGroupInput
              aria-label="Python 启动文件"
              disabled={disabled}
              value={config.pythonExecutable}
              onChange={(e) => {
                setConfig({ ...config, pythonExecutable: e.target.value });
                setChecked(null);
              }}
              placeholder="自动安装，无需选择"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label="选择 Python 文件"
                disabled={disabled}
                onClick={() =>
                  void run(async () => {
                    const file = await youtubeService.selectPython();
                    if (file) {
                      setConfig((current) => ({ ...current, pythonExecutable: file }));
                      setChecked(null);
                    }
                  })
                }
              >
                <Folder className="size-3.5" />
                选择
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </ConfigRow>
        <ConfigRow title="运行依赖" description="安装后检查是否可用。">
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
                  setNotice("依赖安装中，可查看日志。");
                })
              }
            >
              {status.installing ? "安装中…" : "安装依赖"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={loading || locked}
              onClick={() =>
                void run(async () => {
                  if (changed && !status.running) await persist();
                  setChecked(await youtubeService.checkEnvironment());
                })
              }
            >
              {changed ? "保存并检查" : "检查环境"}
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
          {environment ? (
            <div aria-label="环境检查结果" className="space-y-3 rounded-lg bg-muted/40 p-3">
              <div className="flex items-center gap-2 text-xs font-medium">
                {environment.ready ? (
                  <CheckCircle className="size-4 text-emerald-600" />
                ) : (
                  <DangerTriangle className="size-4 text-amber-600" />
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
                      className={
                        ready ? "text-[11px]" : "text-[11px] text-amber-700 dark:text-amber-400"
                      }
                    >
                      {ready ? "可用" : "未安装"}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              点击安装依赖，自动准备 Python 和运行组件。首次安装需联网。
            </p>
          )}
        </ConfigRow>
      </ConfigPanelSection>
      <ConfigPanelSection title="网络" description="授权和上传时使用。">
        <ConfigRow title="代理端口" description="不使用代理时留空。">
          <Input
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
      <ConfigPanelSection title="Web 访问" description="服务启动后，可在浏览器添加任务和管理账号。">
        <ConfigRow title="Web 端口">
          <Input
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
                  <code className="text-xs">{url}</code>
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
      <ConfigPanelSection title="Google 凭据" description="导入一次，即可为多个账号授权。">
        <ConfigRow title="凭据文件" description="client_secret.json">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{metadata?.credentialsImported ? "已导入" : "未导入"}</Badge>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  if (await youtubeService.importCredentials()) {
                    setMetadata(await youtubeService.config());
                    setNotice("凭据已导入，请到账号管理授权。");
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
