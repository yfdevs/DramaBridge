import { formatAutomationErrorReport } from "@dramabridge/automation-logging";
import type { KuaishouDramaPublishVariant } from "../shared/types.js";
import { KuaishouBrowserUnavailableError } from "./task-pages.js";

export type KuaishouDramaVariantFailure = {
  variant: KuaishouDramaPublishVariant;
  error: unknown;
};

export function kuaishouVariantLabel(variant: KuaishouDramaPublishVariant) {
  const label =
    variant.kind === "full-paid"
      ? "付费版"
      : `广告版${variant.kind === "ad-unlock" ? 1 : variant.kind.slice("ad-unlock-".length)}`;
  return `${label}“${variant.title}”`;
}

export class KuaishouDramaVariantFailures extends Error {
  constructor(
    readonly succeeded: KuaishouDramaPublishVariant["kind"][],
    readonly failures: KuaishouDramaVariantFailure[],
  ) {
    const details = failures.map(
      ({ variant, error }) =>
        `${kuaishouVariantLabel(variant)}：${formatAutomationErrorReport(error, { maxLength: 600 })}`,
    );
    super(
      `快手多版本上传未全部完成，成功 ${succeeded.length}/${succeeded.length + failures.length} 个版本。` +
        `失败版本及原因：${details.join("；")}（错误码：KUAISHOU_DRAMA_PUBLISH_VARIANTS_FAILED）`,
    );
    this.name = "KuaishouDramaVariantFailures";
  }
}

/** Each version is independent; report the task only after all have been attempted. */
export async function executeKuaishouDramaVariants(
  variants: KuaishouDramaPublishVariant[],
  execute: (variant: KuaishouDramaPublishVariant, index: number) => Promise<void>,
  isAlreadySubmitted?: (variant: KuaishouDramaPublishVariant) => Promise<boolean>,
) {
  const succeeded: KuaishouDramaPublishVariant["kind"][] = [];
  const failures: KuaishouDramaVariantFailure[] = [];
  for (const [index, variant] of variants.entries()) {
    try {
      if (!(await isAlreadySubmitted?.(variant))) await execute(variant, index);
      succeeded.push(variant.kind);
    } catch (error) {
      failures.push({ variant, error });
      if (error instanceof KuaishouBrowserUnavailableError) {
        for (const pending of variants.slice(index + 1)) {
          failures.push({ variant: pending, error: new Error("自动化浏览器连接已断开，该版本未执行；请重新启动快手服务后重试") });
        }
        break;
      }
    }
  }
  if (failures.length) throw new KuaishouDramaVariantFailures(succeeded, failures);
  return succeeded;
}
