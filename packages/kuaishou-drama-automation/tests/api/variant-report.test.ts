import assert from "node:assert/strict";
import test from "node:test";
import { formatAutomationErrorReport } from "@dramabridge/automation-logging";
import {
  reportKuaishouDramaTaskErrorApi,
  reportKuaishouDramaTaskSuccessApi,
} from "../../src/api/task.js";
import type { KuaishouDramaHttpClient } from "../../src/api/http-client.js";
import { KuaishouDramaVariantFailures } from "../../src/automation/variant-results.js";
import type { KuaishouDramaPublishVariant } from "../../src/shared/types.js";

test("reports every failed version without truncation or suppressing a closed version tab", async () => {
  const failures = Array.from({ length: 8 }, (_, index) => ({
    variant: {
      kind: index === 0 ? "ad-unlock" : `ad-unlock-${index + 1}`,
      title: `测试剧${index + 1}`,
      saleMode: "观看广告解锁",
      episodePriceRanges: [],
    } as KuaishouDramaPublishVariant,
    error: new Error(index === 1 ? "Target page has been closed" : "视频上传失败".repeat(80)),
  }));
  const message = formatAutomationErrorReport(new KuaishouDramaVariantFailures([], failures), {
    maxLength: 10_000,
  });
  const calls: unknown[] = [];
  const client: KuaishouDramaHttpClient = {
    async post(path, body) {
      assert.ok(path.endsWith("/rpa/report"));
      calls.push(body);
      return { code: 0, data: true } as never;
    },
  };
  await reportKuaishouDramaTaskErrorApi({
    client,
    accountTaskId: 12,
    failStage: "UPLOAD_FILE",
    errorMessage: message,
  });
  assert.equal(calls.length, 1);
  const report = calls[0] as { success: boolean; errorMessage: string };
  assert.equal(report.success, false);
  assert.ok(report.errorMessage.length > 1_000);
  for (let index = 1; index <= 8; index += 1)
    assert.ok(report.errorMessage.includes(`广告版${index}“测试剧${index}”`));
});

test("reports success with all versions after a successful retry", async () => {
  const calls: unknown[] = [];
  const client: KuaishouDramaHttpClient = {
    async post(_path, body) {
      calls.push(body);
      return { code: 0, data: true } as never;
    },
  };
  await reportKuaishouDramaTaskSuccessApi({
    client,
    accountTaskId: 12,
    resultJson: { variants: ["ad-unlock", "ad-unlock-2", "ad-unlock-3"] },
  });
  assert.deepEqual(calls, [
    {
      taskId: 12,
      success: true,
      failStage: undefined,
      errorMessage: undefined,
      resultJson: { variants: ["ad-unlock", "ad-unlock-2", "ad-unlock-3"] },
    },
  ]);
});
