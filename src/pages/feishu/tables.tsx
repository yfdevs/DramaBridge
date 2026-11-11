import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfigSection, type ConfigSectionDefinition } from "@/pages/shared/configuration-page";
import { feishuService } from "@/platforms/feishu/service";

export type FeishuConfigFields = {
  feishuAppId: string;
  feishuAppSecret: string;
  feishuTableUrl: string;
  feishuHasSecret: boolean;
};

export function FeishuGlobalConfiguration({
  config,
  onChange,
  disabled,
  hasChanges,
}: {
  config: FeishuConfigFields;
  onChange: (key: keyof FeishuConfigFields, value: string) => void;
  disabled: boolean;
  hasChanges: boolean;
}) {
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const section: ConfigSectionDefinition<FeishuConfigFields> = {
    title: "飞书表格",
    description: "连接各平台共用的任务表。",
    fields: [
      { key: "feishuAppId", label: "应用 ID" },
      {
        key: "feishuAppSecret",
        label: "应用密钥",
        type: "password",
        placeholder: config.feishuHasSecret ? "已保存，留空保留原密钥" : "输入 App Secret",
      },
      { key: "feishuTableUrl", label: "表格链接", type: "url" },
    ],
  };
  const test = async () => {
    setTesting(true);
    setMessage("");
    setFailed(false);
    try {
      await feishuService.test();
      setMessage("连接成功");
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "连接失败，请检查配置和表格权限。");
    } finally {
      setTesting(false);
    }
  };
  return (
    <div role="region" aria-label="飞书表格连接">
      <ConfigSection
        section={section}
        fields={section.fields}
        config={config}
        onChange={(key, value) => {
          setMessage("");
          onChange(key, value);
        }}
        footer={
          <div className="flex flex-wrap items-center justify-end gap-3">
            {message && (
              <p
                role={failed ? "alert" : "status"}
                className={`max-w-prose text-sm ${failed ? "text-destructive" : "text-muted-foreground"}`}
              >
                {message}
              </p>
            )}
            {hasChanges && <p className="text-xs text-muted-foreground">保存更改后可测试连接</p>}
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || testing || hasChanges || !config.feishuHasSecret}
              title={hasChanges ? "请先保存配置" : undefined}
              onClick={() => void test()}
            >
              {testing ? "连接中…" : "测试连接"}
            </Button>
          </div>
        }
      />
    </div>
  );
}
