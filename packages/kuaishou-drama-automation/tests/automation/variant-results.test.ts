import assert from "node:assert/strict";
import test from "node:test";
import { formatAutomationErrorReport } from "@dramabridge/automation-logging";
import {
  executeKuaishouDramaVariants,
  KuaishouDramaVariantFailures,
} from "../../src/automation/variant-results.js";
import type { KuaishouDramaPublishVariant } from "../../src/shared/types.js";
import { KuaishouBrowserUnavailableError } from "../../src/automation/task-pages.js";

const variants: KuaishouDramaPublishVariant[] = Array.from({ length: 8 }, (_, index) => ({
  kind: index === 0 ? "ad-unlock" : `ad-unlock-${index + 1}`,
  title: `测试剧${index + 1}`,
  saleMode: "观看广告解锁",
  episodePriceRanges: [],
}));

test("attempts later variants after failures and preserves every failure and completed version", async () => {
  const attempted: string[] = [];
  await assert.rejects(
    executeKuaishouDramaVariants(variants, async (variant, index) => {
      attempted.push(variant.kind);
      if (index === 0) throw new Error("KUAISHOU_DRAMA_VIDEO_UPLOAD_FAILED: 第一版视频失败");
      if (index === 3)
        throw new Error("KUAISHOU_DRAMA_NEXT_STEP_VALIDATION_FAILED: 第四版表单失败");
    }),
    (error: unknown) => {
      assert.ok(error instanceof KuaishouDramaVariantFailures);
      assert.deepEqual(
        error.succeeded,
        variants.filter((_, index) => index !== 0 && index !== 3).map((v) => v.kind),
      );
      assert.deepEqual(
        error.failures.map((f) => f.variant.kind),
        ["ad-unlock", "ad-unlock-4"],
      );
      const report = formatAutomationErrorReport(error, { maxLength: 10_000 });
      assert.match(report, /成功 6\/8 个版本/u);
      assert.match(report, /广告版1“测试剧1”/u);
      assert.match(report, /第一版视频失败/u);
      assert.match(report, /广告版4“测试剧4”/u);
      assert.match(report, /第四版表单失败/u);
      assert.equal(formatAutomationErrorReport(report, { maxLength: 10_000 }), report);
      return true;
    },
  );
  assert.deepEqual(
    attempted,
    variants.map((v) => v.kind),
  );
});

test("returns every expected version on full success", async () => {
  assert.deepEqual(
    await executeKuaishouDramaVariants(variants, async () => {}),
    variants.map((v) => v.kind),
  );
});

test("a browser disconnection preserves completed versions and marks later versions unexecuted", async () => {
  const attempted: string[] = [];
  await assert.rejects(executeKuaishouDramaVariants(variants, async (variant, index) => {
    attempted.push(variant.kind);
    if (index === 1) throw new KuaishouBrowserUnavailableError();
  }), (error: unknown) => {
    assert.ok(error instanceof KuaishouDramaVariantFailures);
    assert.deepEqual(error.succeeded, ["ad-unlock"]);
    assert.equal(error.failures.length, 7);
    assert.ok(error.failures.slice(1).every(item => String(item.error).includes("未执行")));
    return true;
  });
  assert.deepEqual(attempted, ["ad-unlock", "ad-unlock-2"]);
});

test("a retry checks all versions, skips previous successes, and succeeds after the missing version is uploaded", async () => {
  const submitted = new Set<KuaishouDramaPublishVariant["kind"]>();
  const firstAttempts: string[] = [];
  await assert.rejects(
    executeKuaishouDramaVariants(
      variants,
      async (variant) => {
        firstAttempts.push(variant.kind);
        if (variant.kind === "ad-unlock-2") throw new Error("视频上传失败");
        submitted.add(variant.kind);
      },
      async (variant) => submitted.has(variant.kind),
    ),
    KuaishouDramaVariantFailures,
  );
  assert.equal(firstAttempts.length, 8);
  assert.equal(submitted.size, 7);

  const checked: string[] = [];
  const retried: string[] = [];
  const result = await executeKuaishouDramaVariants(
    variants,
    async (variant) => {
      retried.push(variant.kind);
      submitted.add(variant.kind);
    },
    async (variant) => {
      checked.push(variant.kind);
      return submitted.has(variant.kind);
    },
  );
  assert.deepEqual(
    checked,
    variants.map((v) => v.kind),
  );
  assert.deepEqual(retried, ["ad-unlock-2"]);
  assert.deepEqual(
    result,
    variants.map((v) => v.kind),
  );

  // The success callback can be retried even when no local upload is needed.
  assert.deepEqual(
    await executeKuaishouDramaVariants(
      variants,
      async () => {
        assert.fail("an already submitted version must not be uploaded again");
      },
      async (variant) => submitted.has(variant.kind),
    ),
    variants.map((v) => v.kind),
  );
});

test("a lookup failure fails only that version and never creates it blindly", async () => {
  const published: string[] = [];
  await assert.rejects(
    executeKuaishouDramaVariants(
      variants,
      async (variant) => {
        published.push(variant.kind);
      },
      async (variant) => {
        if (variant.kind === "ad-unlock-3")
          throw new Error("KUAISHOU_DRAMA_EXISTING_QUERY_FAILED: 查询失败");
        return variant.kind === "ad-unlock";
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof KuaishouDramaVariantFailures);
      assert.equal(error.succeeded.length, 7);
      assert.equal(error.failures[0]?.variant.kind, "ad-unlock-3");
      return true;
    },
  );
  assert.deepEqual(
    published,
    variants.filter((v) => !["ad-unlock", "ad-unlock-3"].includes(v.kind)).map((v) => v.kind),
  );
});

test("retains all eight failed versions in the formatted report", async () => {
  await assert.rejects(
    executeKuaishouDramaVariants(variants, async () => {
      throw new Error(`KUAISHOU_DRAMA_VIDEO_UPLOAD_FAILED: ${"视频上传失败".repeat(80)}`);
    }),
    (error: unknown) => {
      const report = formatAutomationErrorReport(error, { maxLength: 10_000 });
      assert.ok(report.length > 1_000);
      for (let index = 1; index <= 8; index += 1)
        assert.ok(report.includes(`广告版${index}“测试剧${index}”`));
      assert.equal(formatAutomationErrorReport(report, { maxLength: 10_000 }), report);
      return true;
    },
  );
});
