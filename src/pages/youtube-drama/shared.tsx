import { youtubeService, isYoutubeWeb } from "@/platforms/youtube-drama/service";
import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceActions } from "@/components/workspace-toolbar";
import { DangerTriangle, CheckCircle } from "@mynaui/icons-react";
import type { YoutubeModel } from "./use-youtube-runtime";
export function YoutubeSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select
      value={value}
      onValueChange={(value) => {
        if (value !== null) onChange(value);
      }}
      items={options}
    >
      <SelectTrigger aria-label={label} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
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
          className="rounded-lg bg-destructive/10 px-3 py-2.5 text-xs leading-5 text-destructive"
        >
          {model.error || model.status.error}
        </div>
      )}
      {model.notice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-xs leading-5"
        >
          <CheckCircle className="mt-0.5 size-4 shrink-0 text-emerald-600" />
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
  return (
    <WorkspaceActions label="YouTube 操作">
      <h1 className="sr-only">{title}</h1>
      {children}
      <Badge variant="secondary" className="gap-1.5 text-xs">
        <span
          className={`size-1.5 rounded-full ${status.running ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
        />
        {status.installing
          ? "准备依赖中"
          : status.starting
            ? "启动中"
            : status.running
              ? "服务运行中"
              : "已停止"}
      </Badge>
      {!isYoutubeWeb && model.status.webUrls?.length ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => void model.run(() => youtubeService.openWeb())}
        >
          打开 Web
        </Button>
      ) : null}
      {!isYoutubeWeb && (
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          disabled={locked}
          onClick={() => void run(status.running ? youtubeService.stop : youtubeService.start)}
        >
          {status.running ? "停止服务" : "启动服务"}
        </Button>
      )}
    </WorkspaceActions>
  );
}
export function YoutubeServiceRequired({ model }: { model: YoutubeModel }) {
  return !model.status.running ? (
    <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
      请先启动服务。首次使用请先配置环境。
    </p>
  ) : null;
}
export function YoutubeEnvironmentWarning({ model }: { model: YoutubeModel }) {
  const environment = model.environment;
  return model.status.running && environment && !environment.ready ? (
    <div className="flex items-start gap-2.5 rounded-lg border border-amber-200/60 bg-amber-50/50 px-3 py-2.5 text-xs leading-5 dark:border-amber-900/50 dark:bg-amber-950/20">
      <DangerTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">环境未就绪</p>
        <p className="text-muted-foreground">
          Python {environment.python}
          {!environment.compatible && " · 需要 3.10 以上"}
          。请先配置环境。
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
