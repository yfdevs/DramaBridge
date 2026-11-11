import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceActions } from "@/components/workspace-toolbar";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { CheckCircle, DangerTriangle, ExternalLink, Folder } from "@mynaui/icons-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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

const ConfigurationBusyContext = createContext(false);

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
  placeholder?: string;
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

export type ConfigSelectField<TConfig> = {
  kind: "select";
  key: ConfigFieldKey<TConfig>;
  label: string;
  description?: string;
  options: { value: string; label: string }[];
};

export type ConfigFieldDefinition<TConfig> =
  | ConfigTextField<TConfig>
  | ConfigSwitchField<TConfig>
  | ConfigSelectField<TConfig>;

export type ConfigSectionDefinition<TConfig> = {
  title: string;
  description: string;
  fields: ConfigFieldDefinition<TConfig>[];
  layout?: "default" | "compact";
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
  const [loading, setLoading] = useState(true);

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
  maxWidth = "max-w-[920px]",
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
  const contentRef = useRef<HTMLDivElement>(null);
  const [sectionLinks, setSectionLinks] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    const sections = contentRef.current?.querySelectorAll<HTMLElement>(
      "section[data-config-title]",
    );
    setSectionLinks(
      Array.from(sections ?? [], (section) => ({
        id: section.id,
        title: section.dataset.configTitle ?? "",
      })),
    );
  }, [children]);
  const save = () => {
    const inputs = contentRef.current?.querySelectorAll<HTMLInputElement>("input");
    for (const input of inputs ?? []) {
      if (!input.closest("[data-independent-config]") && !input.reportValidity()) return;
    }
    onSave();
  };
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
    <main aria-label={title} className="configuration-theme flex min-w-0 flex-1 flex-col bg-background">
      <ConfigurationToolbar
        title={title}
        hasChanges={hasChanges}
        loading={loading}
        restartRequired={restartRequired}
        onCancel={cancelConfig}
        onSave={save}
      />

      <div
        className={`@container mx-auto flex w-full ${maxWidth} flex-1 flex-col gap-8 px-5 py-6 sm:px-8`}
      >
        {sectionLinks.length > 3 ? (
          <nav aria-label="配置分组" className="flex flex-wrap gap-x-4 gap-y-2 border-b pb-4">
            {sectionLinks.map((section) => (
              <button
                key={section.id}
                type="button"
                className="rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                onClick={() =>
                  contentRef.current
                    ?.querySelector(`[id="${section.id}"]`)
                    ?.scrollIntoView({ block: "start" })
                }
              >
                {section.title}
              </button>
            ))}
          </nav>
        ) : null}
        <ConfigurationBusyContext.Provider value={loading}>
          <div ref={contentRef} aria-busy={loading} className="flex min-w-0 flex-col gap-8">
            {children}
          </div>
        </ConfigurationBusyContext.Provider>
      </div>
    </main>
  );
}

export function ConfigurationToolbar({
  title,
  hasChanges,
  loading,
  restartRequired,
  onCancel,
  onSave,
}: {
  title: string;
  hasChanges: boolean;
  loading: boolean;
  restartRequired: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <WorkspaceActions label="配置操作">
      <span className="sr-only">{title}</span>
      <Button
        size="sm"
        className="h-7 min-w-14 px-3 text-xs"
        disabled={loading}
        onClick={onCancel}
        variant="outline"
      >
        {hasChanges ? "放弃更改" : "返回"}
      </Button>
      <Button
        size="sm"
        className="h-7 min-w-14 px-3 text-xs"
        disabled={loading || !hasChanges}
        aria-busy={loading}
        onClick={onSave}
      >
        保存更改
      </Button>
      <div className="configuration-theme ml-1 flex items-center" role="status" aria-live="polite">
        {loading ? (
          <span className="text-xs text-muted-foreground">正在处理…</span>
        ) : restartRequired ? (
          <span
            className="inline-flex items-center gap-1.5 text-xs text-[var(--config-warning)]"
            title={hasChanges ? "存在未保存更改；保存后需重启服务" : "配置已保存，需重启服务生效"}
          >
            <DangerTriangle className="size-3.5" />
            {hasChanges ? "未保存，保存后需重启服务" : "已保存，需重启服务"}
          </span>
        ) : (
          <ConfigSaveStateBadge hasChanges={hasChanges} />
        )}
      </div>
    </WorkspaceActions>
  );
}

function ConfigSaveStateBadge({ hasChanges }: { hasChanges: boolean }) {
  return (
    <span
      className={
        hasChanges
          ? "inline-flex items-center gap-1.5 text-xs text-[var(--config-warning)]"
          : "inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      }
    >
      {hasChanges ? (
        <DangerTriangle className="size-3.5" />
      ) : (
        <CheckCircle className="size-3.5 text-muted-foreground" />
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
  section: Pick<ConfigSectionDefinition<TConfig>, "description" | "layout" | "title">;
}) {
  const sectionFields = fields ?? [];
  const busy = useContext(ConfigurationBusyContext);

  return (
    <ConfigPanelSection
      description={section.description}
      layout={section.layout}
      title={section.title}
    >
      <fieldset disabled={busy} className="min-w-0">
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
      </fieldset>
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
  layout = "default",
  title,
}: {
  children: ReactNode;
  description: string;
  layout?: "default" | "compact";
  title: string;
}) {
  const compact = layout === "compact";
  const sectionId = useId();

  return (
    <section
      id={`config-${sectionId}`}
      data-config-title={title}
      aria-label={title}
      className={compact ? "scroll-mt-6" : "scroll-mt-6 space-y-2 border-t pt-5"}
    >
      {!compact ? (
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? (
            <p className="max-w-prose text-xs leading-5 text-muted-foreground">{description}</p>
          ) : null}
        </div>
      ) : null}
      <FieldGroup className="gap-0">{children}</FieldGroup>
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

  if (field.kind === "select") {
    return (
      <Field className="gap-2.5 py-4 @min-[620px]:grid @min-[620px]:grid-cols-[minmax(0,1fr)_minmax(280px,1fr)] @min-[620px]:gap-x-8 @min-[620px]:items-center">
        <FieldContent>
          <FieldLabel className="text-sm" htmlFor={field.key}>
            {field.label}
          </FieldLabel>
          {field.description && (
            <FieldDescription id={`${field.key}-description`} className="text-xs leading-5">
              {field.description}
            </FieldDescription>
          )}
        </FieldContent>
        {field.options.length <= 3 ? (
          <RadioGroup
            id={field.key}
            aria-describedby={field.description ? `${field.key}-description` : undefined}
            aria-label={field.label}
            value={value}
            onValueChange={(next) => onChange?.(field.key, String(next))}
            className="flex flex-wrap items-center gap-x-4 gap-y-1"
          >
            {field.options.map((option) => (
              <label
                key={option.value}
                className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-1 text-sm hover:bg-muted"
              >
                <RadioGroupItem value={option.value} />
                {option.label}
              </label>
            ))}
          </RadioGroup>
        ) : (
          <Select
            value={value}
            onValueChange={(next) => {
              if (next) onChange?.(field.key, next);
            }}
          >
            <SelectTrigger
              id={field.key}
              aria-describedby={field.description ? `${field.key}-description` : undefined}
              className="h-8 w-full text-sm"
            >
              <SelectValue>
                {field.options.find((option) => option.value === value)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {field.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
    );
  }

  if (field.kind === "switch") {
    const checked = value === "true";

    return (
      <Field className="gap-2.5 py-4 @min-[620px]:grid @min-[620px]:grid-cols-[minmax(0,1fr)_minmax(280px,1fr)] @min-[620px]:gap-x-8 @min-[620px]:items-center">
        <FieldContent>
          <FieldLabel className="text-sm" htmlFor={field.key}>
            {field.label}
          </FieldLabel>
          {field.description ? (
            <FieldDescription id={`${field.key}-description`} className="text-xs leading-5">
              {field.description}
            </FieldDescription>
          ) : null}
        </FieldContent>
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {checked ? field.activeLabel : field.inactiveLabel}
          </span>
          <Switch
            id={field.key}
            aria-describedby={field.description ? `${field.key}-description` : undefined}
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
    <Field className="gap-2.5 py-4 @min-[620px]:grid @min-[620px]:grid-cols-[minmax(0,1fr)_minmax(280px,1fr)] @min-[620px]:gap-x-8 @min-[620px]:items-start">
      <FieldContent>
        <FieldLabel className="text-sm" htmlFor={field.key}>
          {field.label}
        </FieldLabel>
        {field.description ? (
          <FieldDescription id={`${field.key}-description`} className="text-xs leading-5">
            {field.description}
          </FieldDescription>
        ) : null}
      </FieldContent>
      <div className="w-full min-w-0">
        <InputGroup>
          <InputGroupInput
            className="text-sm md:text-sm"
            id={field.key}
            aria-describedby={field.description ? `${field.key}-description` : undefined}
            placeholder={field.placeholder}
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
    <Field className="gap-2.5 py-4 @min-[620px]:grid @min-[620px]:grid-cols-[minmax(0,1fr)_minmax(280px,1fr)] @min-[620px]:gap-x-8 @min-[620px]:items-start">
      <FieldContent>
        <FieldLabel className="text-sm">{label}</FieldLabel>
        <FieldDescription className="text-xs leading-5">{description}</FieldDescription>
      </FieldContent>
      <div className="flex min-w-0 items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs"
          title={pathText || "尚未设置"}
        >
          {pathText || "尚未设置"}
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
