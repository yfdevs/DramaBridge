import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { DramaAiClient } from "@dramabridge/ai";
import sharp from "sharp";
import { classifyOwnershipProjectProofScreenshotWithAi } from "../src/ownership-project-proof-ai.js";

async function imageFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "ownership-cropped-editor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "工程截图.png");
  await sharp({ create: { width: 800, height: 450, channels: 3, background: "#303438" } })
    .png()
    .toFile(file);
  return file;
}

function visionClient(...responses: Record<string, unknown>[]): DramaAiClient {
  let call = 0;
  return {
    analyzeImages: async () => ({
      finishReason: "stop",
      model: "test-vision-model",
      text: JSON.stringify(responses[Math.min(call++, responses.length - 1)]),
    }),
    generateImage: async () => {
      throw new Error("not used");
    },
    generateText: async () => {
      throw new Error("not used");
    },
  };
}

test("recognizes a Jianying editor even when the application label was cropped out", async (t) => {
  const file = await imageFixture(t);
  assert.equal(
    await classifyOwnershipProjectProofScreenshotWithAi(
      file,
      visionClient({
        isEngineeringScreenshot: true,
        jianyingLabelVisible: false,
        jianyingEditorVisible: true,
        evidence: "剪映素材栏、字幕轨道和画面位置大小面板可见，顶部品牌栏被裁掉",
      }),
    ),
    "jianying",
  );
});

test("recognizes a cropped Jianying workspace during the ambiguity recheck", async (t) => {
  const file = await imageFixture(t);
  assert.equal(
    await classifyOwnershipProjectProofScreenshotWithAi(
      file,
      visionClient(
        {
          isEngineeringScreenshot: false,
          jianyingLabelVisible: false,
          jianyingEditorVisible: false,
        },
        { isEngineeringScreenshot: true, jianyingLabelVisible: false, jianyingEditorVisible: true },
      ),
    ),
    "jianying",
  );
});

test("does not treat a character picture or finished frame as a project screenshot", async (t) => {
  const file = await imageFixture(t);
  assert.equal(
    await classifyOwnershipProjectProofScreenshotWithAi(
      file,
      visionClient({
        isEngineeringScreenshot: false,
        jianyingLabelVisible: false,
        jianyingEditorVisible: true,
      }),
    ),
    "unknown",
  );
});

test("keeps other production interfaces separate from Jianying", async (t) => {
  const file = await imageFixture(t);
  assert.equal(
    await classifyOwnershipProjectProofScreenshotWithAi(
      file,
      visionClient({
        isEngineeringScreenshot: true,
        jianyingLabelVisible: false,
        jianyingEditorVisible: false,
      }),
    ),
    "juchuang",
  );
});

test("continues accepting visible Jianying labels and older classification responses", async (t) => {
  const file = await imageFixture(t);
  for (const response of [
    { isEngineeringScreenshot: true, jianyingLabelVisible: true },
    { kind: "jianying" },
  ]) {
    assert.equal(
      await classifyOwnershipProjectProofScreenshotWithAi(file, visionClient(response)),
      "jianying",
    );
  }
});

test("accepts an explicit workspace judgement without requiring a separate branding flag", async (t) => {
  const file = await imageFixture(t);
  assert.equal(
    await classifyOwnershipProjectProofScreenshotWithAi(
      file,
      visionClient({
        isEngineeringScreenshot: true,
        jianyingEditorVisible: true,
      }),
    ),
    "jianying",
  );
});

test("does not coerce a text branding flag into positive Jianying evidence", async (t) => {
  const file = await imageFixture(t);
  assert.equal(
    await classifyOwnershipProjectProofScreenshotWithAi(
      file,
      visionClient({
        isEngineeringScreenshot: true,
        jianyingLabelVisible: "false",
        jianyingEditorVisible: false,
      }),
    ),
    "juchuang",
  );
});
