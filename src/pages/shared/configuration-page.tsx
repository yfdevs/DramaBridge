import { CheckCircle, DangerTriangle, ExternalLink, Folder } from "@mynaui/icons-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { defaultRoute, isAppRoute, platformForPath, routePath } from "@/config/navigation";

type ConfigResult<TConfig> = {
  config: TConfig;
  restartRequired: boolean;
};

type ConfigFieldKey<TConfig> = Extract<keyof TConfig, string>;

export type ConfigTextField<TConfig> = {
  kind?: "text";
  key: ConfigFieldKey<TConfig>;
  label: string;
  description?: string;
  type?: "text" | "number" | "password" | "url";
  suffix?: string;
  directory?: boolean;
  min?: number;
  max?: number;
  step?: number | string;
};

export type ConfigSwitchField<TConfig> = {
  kind: "switch";
  key: ConfigFieldKey<TConfig>;
  label: string;
  description?: string;
  activeLabel: string;
  inactiveLabel: string;
};

export type ConfigFieldDefinition<TConfig> = ConfigTextField<TConfig> | ConfigSwitchField<TConfig>;

export type ConfigSectionDefinition<TConfig> = {
  title: string;
  description: string;
  fields: ConfigFieldDefinition<TConfig>[];
};

export function usePlatformConfig<TConfig extends object, TResult extends ConfigResult<TConfig>>({
  emptyConfig,
  getConfig,
  saveConfig,
  onApplyResult,
}: {
  emptyConfig: TConfig;
  getConfig: () => Promise<TResult>;
  saveConfig: (config: TConfig) => Promise<TResult>;
  onApplyResult?: (result: TResult) => void;
}) {
  const [config, setConfig] = useState<TConfig>(emptyConfig);
  const [savedConfig, setSavedConfig] = useState<TConfig>(emptyConfig);
  const [restartRequired, setRestartRequired] = useState(false);
  const [loading, setLoading] = useState(false);

  const hasChanges = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(savedConfig),
    [config, savedConfig],
  );

  const applyResult = (result: TResult) => {
    setConfig(result.config);
    setSavedConfig(result.config);
    setRestartRequired(result.restartRequired);
    onApplyResult?.(result);
  };

  useEffect(() => {
    setLoading(true);
    getConfig()
      .then(applyResult)
      .catch((error) => {
        toast.error("配置读取失败", {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => setLoading(false));
  }, []);

  const updateConfig = (key: ConfigFieldKey<TConfig>, value: string) => {
    setConfig((current) => ({ ...current, [key]: value }) as TConfig);
  };

  const discardChanges = () => {
    setConfig(savedConfig);
  };

  const persistConfig = async () => {
    setLoading(true);
    try {
      const result = await saveConfig(config);
      applyResult(result);
      if (result.restartRequired) {
        toast.warning("配置已保存", {
          description: "服务正在运行，请重启服务后生效。",
        });
      } else {
        toast.success("配置已保存");
      }
    } catch (error) {
      toast.error("配置保存失败", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  };

  return {
    config,
    discardChanges,
    hasChanges,
    loading,
    persistConfig,
    restartRequired,
    savedConfig,
    setConfig,
    updateConfig,
  };
}

export function ConfigurationPageFrame({
  children,
  hasChanges,
  loading,
  maxWidth = "max-w-[760px]",
  onDiscard,
  onClose,
  onSave,
  restartRequired,
  title,
}: {
  children: ReactNode;
  hasChanges: boolean;
  loading: boolean;
  maxWidth?: string;
  onDiscard: () => void;
  onClose?: () => void;
  onSave: () => void;
  restartRequired: boolean;
  title: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = location.pathname.replace(/^\/+/, "");
  const activeRoute = isAppRoute(currentPath) ? currentPath : defaultRoute;
  const activePlatform = platformForPath(activeRoute);

  const cancelConfig = () => {
    onDiscard();
    if (onClose) {
      onClose();
    } else {
      void navigate(routePath(activePlatform.serviceRoute));
    }
  };

  return (
    <main className="flex min-h-svh flex-1 flex-col bg-background">
      <div className="sticky top-0 z-10 border-b bg-background/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-215 gap-3 flex-row justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="mr-1 text-lg font-semibold tracking-normal">{title}</h1>
            <ConfigSaveStateBadge hasChanges={hasChanges} />
            {restartRequired ? (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-orange-300 bg-orange-50 px-2 text-xs font-medium text-orange-900 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200">
                <DangerTriangle className="size-3.5" />
                需重启
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 sm:justify-end">
            <Button className="w-fit" disabled={loading} onClick={cancelConfig} variant="outline">
              关闭
            </Button>
            <Button className="w-fit" disabled={loading || !hasChanges} onClick={onSave}>
              保存配置
            </Button>
          </div>
        </div>
      </div>

      <div className={`mx-auto flex w-full ${maxWidth} flex-1 flex-col gap-7 p-6`}>{children}</div>
    </main>
  );
}

function ConfigSaveStateBadge({ hasChanges }: { hasChanges: boolean }) {
  return (
    <span
      className={
        hasChanges
          ? "inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 text-xs font-medium text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
          : "inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium text-muted-foreground"
      }
    >
      {hasChanges ? (
        <DangerTriangle className="size-3.5" />
      ) : (
        <CheckCircle className="size-3.5 text-emerald-600" />
      )}
      {hasChanges ? "未保存" : "已保存"}
    </span>
  );
}

export function ConfigSection<TConfig extends object>({
  config,
  fields,
  footer,
  onChange,
  onSelectDirectory,
  section,
}: {
  config: TConfig;
  fields?: ConfigFieldDefinition<TConfig>[];
  footer?: ReactNode;
  onChange?: (key: ConfigFieldKey<TConfig>, value: string) => void;
  onSelectDirectory?: (key: ConfigFieldKey<TConfig>) => void;
  section: Pick<ConfigSectionDefinition<TConfig>, "description" | "title">;
}) {
  const sectionFields = fields ?? [];

  return (
    <ConfigPanelSection description={section.description} title={section.title}>
      {sectionFields.map((field, index) => (
        <div key={field.key}>
          {index > 0 ? <Separator /> : null}
          <ConfigFieldControl
            config={config}
            field={field}
            onChange={onChange}
            onSelectDirectory={onSelectDirectory}
          />
        </div>
      ))}
      {footer ? (
        <div>
          <Separator />
          <div className="flex justify-end py-3">{footer}</div>
        </div>
      ) : null}
    </ConfigPanelSection>
  );
}

export function ConfigPanelSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="scroll-mt-28 space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Card className="rounded-none border-0 bg-transparent py-0 shadow-none ring-0">
        <CardContent className="px-0 py-0">
          <FieldGroup className="gap-0">{children}</FieldGroup>
        </CardContent>
      </Card>
    </section>
  );
}

function ConfigFieldControl<TConfig extends object>({
  config,
  field,
  onChange,
  onSelectDirectory,
}: {
  config: TConfig;
  field: ConfigFieldDefinition<TConfig>;
  onChange?: (key: ConfigFieldKey<TConfig>, value: string) => void;
  onSelectDirectory?: (key: ConfigFieldKey<TConfig>) => void;
}) {
  const value = String(config[field.key] ?? "");

  if (field.kind === "switch") {
    const checked = value === "true";

    return (
      <Field className="gap-2.5 py-3 md:grid md:grid-cols-[minmax(220px,1fr)_280px] md:items-center">
        <FieldContent>
          <FieldLabel className="text-[13px]" htmlFor={field.key}>
            {field.label}
          </FieldLabel>
          {field.description ? (
            <FieldDescription className="text-xs">{field.description}</FieldDescription>
          ) : null}
        </FieldContent>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="text-[13px] text-muted-foreground">
            {checked ? field.activeLabel : field.inactiveLabel}
          </span>
          <Switch
            id={field.key}
            checked={checked}
            onCheckedChange={(nextChecked) => {
              onChange?.(field.key, nextChecked ? "true" : "false");
            }}
          />
        </div>
      </Field>
    );
  }

  return (
    <Field className="gap-2.5 py-3 md:grid md:grid-cols-[minmax(220px,1fr)_280px] md:items-start">
      <FieldContent>
        <FieldLabel className="text-[13px]" htmlFor={field.key}>
          {field.label}
        </FieldLabel>
        {field.description ? (
          <FieldDescription className="text-xs">{field.description}</FieldDescription>
        ) : null}
      </FieldContent>
      <div className="w-full min-w-0">
        <InputGroup>
          <InputGroupInput
            className="text-[13px] md:text-[13px]"
            id={field.key}
            min={field.min ?? (field.type === "number" ? 0 : undefined)}
            max={field.max}
            step={field.step}
            type={field.type ?? "text"}
            value={value}
            onChange={(event) => onChange?.(field.key, event.target.value)}
          />
          {field.suffix ? (
            <InputGroupAddon align="inline-end">
              <InputGroupText className="text-xs">{field.suffix}</InputGroupText>
            </InputGroupAddon>
          ) : null}
          {field.directory ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label={`选择${field.label}`}
                className="text-xs"
                onClick={() => onSelectDirectory?.(field.key)}
              >
                <Folder />
                选择
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
    </Field>
  );
}

export function StoragePathRow({
  description,
  label,
  onOpen,
  pathText,
}: {
  description: string;
  label: string;
  onOpen?: () => void;
  pathText: string;
}) {
  return (
    <Field className="gap-2.5 py-3 md:grid md:grid-cols-[minmax(220px,1fr)_360px] md:items-start">
      <FieldContent>
        <FieldLabel className="text-[13px]">{label}</FieldLabel>
        <FieldDescription className="text-xs">{description}</FieldDescription>
      </FieldContent>
      <div className="flex min-w-0 items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs"
          title={pathText || "-"}
        >
          {pathText || "-"}
        </code>
        {onOpen ? (
          <Button aria-label={`打开${label}`} onClick={onOpen} size="icon" variant="outline">
            <ExternalLink className="size-4" />
          </Button>
        ) : null}
      </div>
    </Field>
  );
}
