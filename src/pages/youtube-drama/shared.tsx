import { youtubeService, isYoutubeWeb } from "@/platforms/youtube-drama/service";
import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceActions } from "@/components/workspace-toolbar";
import { DangerTriangle, CheckCircle, Chrome } from "@mynaui/icons-react";
import type { YoutubeModel } from "./use-youtube-runtime";

export function YoutubePageContent({
  children,
  variant = "wide",
}: {
  children: ReactNode;
  variant?: "wide" | "form" | "accounts";
}) {
  if (isYoutubeWeb) {
    return (
      <div className="@container mx-auto flex w-full max-w-[1440px] flex-col px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div
          className={`flex min-w-0 flex-col gap-6 ${variant === "form" ? "max-w-[880px]" : variant === "accounts" ? "max-w-[1120px]" : ""}`}
        >
          {children}
        </div>
      </div>
    );
  }
  return (
    <div
      className={`mx-auto flex w-full flex-col p-4 sm:p-6 ${variant === "form" ? "max-w-[920px] gap-6" : "max-w-[1440px] gap-5"}`}
    >
      {children}
    </div>
  );
}

export function YoutubeSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
}) {
  return (
    <Select
      value={value}
      onValueChange={(value) => {
        if (value !== null) onChange(value);
      }}
      items={options}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="youtube-theme">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
export function YoutubeFeedback({ model }: { model: YoutubeModel }) {
  return (
    <>
      {(model.error || model.status.error) && (
        <div
          role="alert"
          className="rounded-md bg-[var(--youtube-error-bg)] px-3 py-2.5 text-sm leading-6 text-destructive break-words"
        >
          {model.error || model.status.error}
        </div>
      )}
      {model.notice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md bg-[var(--youtube-success-bg)] px-3 py-2.5 text-sm leading-6"
        >
          <CheckCircle
            aria-hidden="true"
            className="mt-1 size-4 shrink-0 text-[var(--youtube-success-text)]"
          />
          {model.notice}
        </div>
      )}
    </>
  );
}
export function YoutubeServiceActions({
  model,
  title,
  children,
}: {
  model: YoutubeModel;
  title: string;
  children?: ReactNode;
}) {
  const { status, locked, run } = model;
  const stateLabel = model.loading
    ? "连接中…"
    : status.installing
      ? "准备依赖中"
      : status.starting
        ? "启动中…"
        : status.running
          ? "服务运行中"
          : "服务已停止";
  return (
    <WorkspaceActions label="YouTube 操作">
      <span className="sr-only">{title}</span>
      <span className="sr-only" role="status" aria-live="polite">
        {stateLabel}
      </span>
      {children}
      {!isYoutubeWeb && status.webUrls?.length ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="浏览器访问"
                disabled={locked}
                onClick={() => void run(() => youtubeService.openWeb())}
              />
            }
          >
            <Chrome aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" sideOffset={8}>
            浏览器访问
          </TooltipContent>
        </Tooltip>
      ) : null}
      {!isYoutubeWeb && (
        <Button
          size="sm"
          variant={status.running ? "outline" : "default"}
          disabled={locked || model.loading}
          onClick={() => void run(status.running ? youtubeService.stop : youtubeService.start)}
        >
          {status.installing
            ? "准备环境…"
            : status.starting
              ? "启动中…"
              : status.running
                ? "停止服务"
                : "启动服务"}
        </Button>
      )}
    </WorkspaceActions>
  );
}

export function YoutubeServiceRequired({ model }: { model: YoutubeModel }) {
  return !model.status.running && !model.loading ? (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted px-3 py-3 text-sm">
      <p>
        {isYoutubeWeb ? "服务已离线，请在桌面端启动后刷新页面" : "启动服务后可管理任务和账号"}
      </p>
      {!isYoutubeWeb && (
        <Button size="sm" variant="outline" render={<Link to="/youtube-drama/config" />}>
          配置环境
        </Button>
      )}
    </div>
  ) : null;
}
export function YoutubeEnvironmentWarning({ model }: { model: YoutubeModel }) {
  const environment = model.environment;
  return model.status.running && environment && !environment.ready ? (
    <div
      role="status"
      className="flex flex-wrap items-start gap-2.5 rounded-md bg-[var(--youtube-warning-bg)] px-3 py-3 text-sm leading-6 text-[var(--youtube-warning-text)]"
    >
      <DangerTriangle aria-hidden="true" className="mt-1 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">环境未就绪</p>
        <p>
          Python {environment.python}
          {!environment.compatible && "，需要 3.10 以上版本"}
          {isYoutubeWeb ? "，请在桌面端检查运行环境" : "，请检查运行环境"}
        </p>
      </div>
      {!isYoutubeWeb && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 text-xs"
          render={<Link to="/youtube-drama/config" />}
        >
          配置环境
        </Button>
      )}
    </div>
  ) : null;
}
