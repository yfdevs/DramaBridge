// oxlint-disable typescript/no-floating-promises
import assert from "node:assert/strict";
import test from "node:test";

import type { KuaishouDramaHttpClient } from "../../src/api/http-client.js";
import { claimNextKuaishouDramaTaskApi } from "../../src/api/task.js";
import { createKuaishouDramaPublishVariants } from "../../src/shared/publish-variants.js";

test("keeps exact dynamic ad-version titles when claiming a backend task", async () => {
  const calls: Array<{ path: string; payload: unknown }> = [];
  const getCalls: string[] = [];
  const client: KuaishouDramaHttpClient = {
    async get(path) {
      getCalls.push(path);
      return {
        code: 0,
        msg: "操作成功",
        data: {
          dataJson: {
            kuaishouPlaylet: {
              publishType: "全部",
              adVersionCount: 6,
              adVersionTitles: [
                "雨夜归人",
                "旧城来信",
                "长街灯火",
                "故园春深",
                "星河入梦",
              ],
            },
          },
        },
      } as never;
    },
    async post(path, payload) {
      calls.push({ path, payload });
      if (path.endsWith("/accountTask/page")) {
        return {
          code: 0,
          msg: "操作成功",
          data: {
            total: 1,
            data: [{
              id: 401,
              dramaId: 901,
              accountId: "kuaishou-account-1",
              accountName: "快手一号",
              status: "READY",
              originalTitle: "逆风归途",
            }],
          },
        } as never;
      }
      if (path.endsWith("/rpa/claim")) {
        return {
          code: 0,
          msg: "操作成功",
          data: {
            accountTaskId: 401,
            accountId: "kuaishou-account-1",
            originalTitle: "逆风归途",
            rpaProfileKey: null,
            accountConfigJson: null,
            payloadJson: {
              name: "逆风归途",
              summary:
                "女主在事业与家庭的双重低谷中重新出发，凭借坚韧和智慧找回人生方向。她在一次次误解与挑战中守住初心，也逐渐揭开旧事背后的真相。面对亲情、友情和爱情的选择，她不再逃避，而是与伙伴并肩前行，最终完成自我成长并迎来新的生活。",
              episodeCount: 60,
              producerName: "制作方",
              productionCost: { amountWan: 1 },
              baiduPanResourceLink: "https://pan.baidu.com/s/example?pwd=1234",
              kuaishouPlaylet: {
                genderChannel: "不限",
                categories: ["脑洞"],
                plotTags: ["其他"],
                publishType: "全部",
                adVersionCount: 6,
                adVersionTitles: [
                  "逆风归途·二",
                  "逆风归途·三",
                  "逆风归途·四",
                  "逆风归途·五",
                  "逆风归途·六",
                ],
              },
            },
          },
        } as never;
      }
      throw new Error(`unexpected path: ${path}`);
    },
  };

  const claimed = await claimNextKuaishouDramaTaskApi({
    client,
    runtimeOptions: { kuaishouAccountId: "kuaishou-account-1" },
  });

  assert.ok(claimed);
  assert.equal(claimed.task.publishType, "全部");
  assert.equal(claimed.task.adVersionCount, 6);
  assert.deepEqual(claimed.task.adVersionTitles, [
    "雨夜归人",
    "旧城来信",
    "长街灯火",
    "故园春深",
    "星河入梦",
  ]);
  assert.deepEqual(
    createKuaishouDramaPublishVariants(claimed.task).map(({ kind, title }) => ({ kind, title })),
    [
      { kind: "full-paid", title: "《逆风归途》" },
      { kind: "ad-unlock", title: "逆风归途" },
      { kind: "ad-unlock-2", title: "雨夜归人" },
      { kind: "ad-unlock-3", title: "旧城来信" },
      { kind: "ad-unlock-4", title: "长街灯火" },
      { kind: "ad-unlock-5", title: "故园春深" },
      { kind: "ad-unlock-6", title: "星河入梦" },
    ],
  );
  assert.deepEqual(calls.map(({ path }) => path), [
    "/dramaAiRpa/kuaishou/accountTask/page",
    "/dramaAiRpa/kuaishou/rpa/claim",
  ]);
  assert.deepEqual(getCalls, ["/dramaAiRpa/detail/901"]);
});

test("fills missing backend ad-version titles with distinct safe titles", async () => {
  const client: KuaishouDramaHttpClient = {
    async post(path) {
      if (path.endsWith("/accountTask/page")) {
        return {
          code: 0,
          msg: "操作成功",
          data: {
            total: 1,
            data: [{
              id: 402,
              dramaId: 902,
              accountId: "kuaishou-account-1",
              status: "READY",
              originalTitle: "逆风归途",
            }],
          },
        } as never;
      }
      if (path.endsWith("/rpa/claim")) {
        return {
          code: 0,
          msg: "操作成功",
          data: {
            accountTaskId: 402,
            accountId: "kuaishou-account-1",
            originalTitle: "逆风归途",
            payloadJson: {
              name: "逆风归途",
              summary:
                "女主在事业与家庭的双重低谷中重新出发，凭借坚韧和智慧找回人生方向。她在一次次误解与挑战中守住初心，也逐渐揭开旧事背后的真相。面对亲情、友情和爱情的选择，她不再逃避，而是与伙伴并肩前行，最终完成自我成长并迎来新的生活。",
              episodeCount: 60,
              producerName: "制作方",
              kuaishouPlaylet: {
                genderChannel: "不限",
                categories: ["脑洞"],
                plotTags: ["其他"],
                publishType: "六个广告版本",
              },
            },
          },
        } as never;
      }
      throw new Error(`unexpected path: ${path}`);
    },
  };

  const claimed = await claimNextKuaishouDramaTaskApi({
    client,
    runtimeOptions: { kuaishouAccountId: "kuaishou-account-1" },
  });

  assert.ok(claimed);
  assert.deepEqual(
    createKuaishouDramaPublishVariants(claimed.task).map(({ title }) => title),
    ["逆风归途", "逆风归途·二", "逆风归途·三", "逆风归途·四", "逆风归途·五", "逆风归途·六"],
  );
});
