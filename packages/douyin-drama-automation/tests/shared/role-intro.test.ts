import assert from "node:assert/strict";
import test from "node:test";
import { createMockDouyinNetdiskTestTask } from "../../src/api/mock-task.js";
import { douyinTaskNeedsNetdiskMetadata, enrichDouyinTaskFromNetdisk } from "../../src/shared/netdisk-metadata.js";
import { douyinDramaRoleSchema } from "../../src/shared/types.js";
import { isDouyinRoleIntroValid, requireDouyinRoleIntro } from "../../src/shared/role-intro.js";

function task() {
  const task = createMockDouyinNetdiskTestTask();
  task.playlet.summary = "刘晓是一名货车司机，长期遭到货主无偿使用货车的要求，他决定维护自己的劳动权益。".repeat(3);
  task.playlet.roles = [
    { name: "刘晓", roleType: "主角", intro: "货车司机", photoFile: "刘晓.png" },
    { name: "货主", roleType: "配角", intro: "长期要求司机提供免费运输服务的货主。", photoFile: "货主.png" },
  ];
  return task;
}

test("short existing introductions alone trigger one targeted AI call and preserve other supplied role details", async () => {
  const input = task();
  const supplied = { ...input.playlet.roles[1] };
  let calls = 0;
  assert.equal(douyinTaskNeedsNetdiskMetadata(input), true);
  const result = await enrichDouyinTaskFromNetdisk(input, {
    aiClientFactory: () => ({ generateText: async options => {
      calls++;
      assert.match(options.prompt, /10-100字/);
      assert.match(options.prompt, /货车司机/);
      assert.match(options.systemPrompt ?? "", /不虚构人物身份、关系或关键剧情/);
      return { model: "test", text: JSON.stringify({ roles: [{ index: 0, intro: "刘晓是一名货车司机，面对无偿运输要求决定维护自己的劳动权益。" }] }) };
    } }),
  });
  assert.equal(calls, 1);
  assert.equal(isDouyinRoleIntroValid(result.playlet.roles[0].intro), true);
  assert.deepEqual(result.playlet.roles[1], supplied);
  assert.equal(douyinTaskNeedsNetdiskMetadata(result), false);
  await enrichDouyinTaskFromNetdisk(result, { aiClientFactory: () => { throw new Error("不应再次调用 AI"); } });
});

test("retries a too-short AI introduction and blocks after two invalid responses", async () => {
  let calls = 0;
  await assert.rejects(enrichDouyinTaskFromNetdisk(task(), {
    aiClientFactory: () => ({ generateText: async () => {
      calls++;
      return { model: "test", text: JSON.stringify({ roles: [{ index: 0, intro: "司机" }] }) };
    } }),
  }), /AI 未能生成10–100字的人物简介：刘晓/);
  assert.equal(calls, 2);
  calls = 0;
  const repaired = await enrichDouyinTaskFromNetdisk(task(), {
    aiClientFactory: () => ({ generateText: async () => ({ model: "test", text: JSON.stringify({ roles: [{ index: 0,
      intro: ++calls === 1 ? "司机" : "刘晓从事货车运输工作，面对不合理要求努力守护自己的劳动权益。",
    }] }) }) }),
  });
  assert.equal(calls, 2);
  assert.ok(isDouyinRoleIntroValid(repaired.playlet.roles[0].intro));
});

test("accepts exactly ten meaningful characters, ignores padding, and requires AI for short or empty input", async () => {
  assert.equal(isDouyinRoleIntroValid("一二三四五六七八九十"), true);
  assert.equal(isDouyinRoleIntroValid("  一 二 三 四 五 六 七 八 九  "), false);
  assert.equal(isDouyinRoleIntroValid("𠮷".repeat(9)), false);
  assert.throws(() => requireDouyinRoleIntro("刘晓", "司机"), /人物简介须为10–100字/);
  assert.equal(douyinDramaRoleSchema.parse({ name: "刘晓", intro: " " }).intro, "");
  assert.equal(douyinDramaRoleSchema.parse({ name: "刘晓", intro: null }).intro, undefined);
  const input = task();
  input.playlet.roles[0].intro = "";
  await assert.rejects(enrichDouyinTaskFromNetdisk(input, {}), /补充人物简介需要全局 AI 配置/);
});

test("AI cannot overwrite a role whose supplied introduction is already valid", async () => {
  const input = task();
  const validIntro = input.playlet.roles[1].intro;
  await assert.rejects(enrichDouyinTaskFromNetdisk(input, {
    aiClientFactory: () => ({ generateText: async () => ({ model: "test", text: JSON.stringify({ roles: [{ index: 1, intro: "这段文字不应该改写已有的合格人物简介。" }] }) }) }),
  }), /AI 未能生成10–100字的人物简介/);
  assert.equal(input.playlet.roles[1].intro, validIntro);
});
