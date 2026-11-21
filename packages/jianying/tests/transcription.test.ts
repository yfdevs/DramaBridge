import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findTranscriptionRuntime, parseTranscript, runTranscriptionHost, transcriptFiles, transcriptionError } from "../src/transcription.js";

test("native ASR microsecond times produce real TXT and SRT with hour boundaries", () => {
  const sentences = parseTranscript({ err_code: 0, result: { sentences: [
    { text: " 第二句 ", start_us: 3_600_005_000, duration_us: 1_250_000 },
    { text: "这是测试", start_us: 80_000, duration_us: 2_420_000 },
  ] } });
  const files = transcriptFiles(sentences);
  assert.equal(files.text, "这是测试\r\n第二句");
  assert.equal(files.srt, "1\r\n00:00:00,080 --> 00:00:02,500\r\n这是测试\r\n\r\n2\r\n01:00:00,005 --> 01:00:01,255\r\n第二句\r\n");
});

test("output-file ASR wrapper and silent results are supported; bad timing is never invented", () => {
  assert.equal(parseTranscript({ asr: { sentences: [{ text: "你好", start_us: 0, duration_us: 1000 }] } })[0].endUs, 1000);
  assert.deepEqual(transcriptFiles(parseTranscript({ sentences: [] })), { text: "", srt: "" });
  for (const sentence of [
    { text: "缺少时间" }, { text: "负时间", start_us: -1, duration_us: 100 },
    { text: "无时长", start_us: 0, duration_us: 0 }, { text: "", start_us: 0, duration_us: 1 },
  ]) assert.throws(() => parseTranscript({ sentences: [sentence] }), /字幕不完整/);
  assert.throws(() => parseTranscript({}), /字幕格式/);
  assert.throws(() => parseTranscript({ err_code: -1, err_msg: "membership entitlement required" }), /会员权益/);
});

test("failures give actionable messages without leaking raw account diagnostics", () => {
  assert.match(transcriptionError(-100305, "secret account diagnostic").message, /登录账号/);
  assert.match(transcriptionError(-1, "unauthorized host process").message, /识别进程/);
  assert.doesNotMatch(transcriptionError(-123, "Bearer private-token account private-id").message, /private|Bearer/);
});

test("runtime discovery chooses an intact numeric newest version, or the selected installation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jianying-runtime-test-"));
  try {
    for (const version of ["9.0.0", "11.8.0.14778", "12.0.0"]) {
      await mkdir(path.join(directory, version));
      await writeFile(path.join(directory, version, "vebun.exe"), "");
      if (version !== "12.0.0") await writeFile(path.join(directory, version, "lyra-cli.exe"), "");
    }
    assert.equal((await findTranscriptionRuntime(directory)).cli, path.join(directory, "11.8.0.14778", "lyra-cli.exe"));
    assert.equal((await findTranscriptionRuntime(directory, path.join(directory, "9.0.0", "JianyingPro.exe"))).cli, path.join(directory, "9.0.0", "lyra-cli.exe"));
    await assert.rejects(findTranscriptionRuntime(path.join(directory, "missing")), /未找到剪映/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("host runner passes spaces, Chinese, quotes and shell characters literally", async () => {
  const input = 'D:/视频 files/a "quote" $() & `name`.mp4';
  const reply = await runTranscriptionHost({ bun: process.execPath, cli: process.execPath }, [
    "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", input,
  ]);
  assert.equal(reply.exitCode, 0);
  assert.deepEqual(JSON.parse(reply.stdout), [input]);
});

test("host runner cancels the process tree and rejects instead of reporting success", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    await assert.rejects(runTranscriptionHost({ bun: process.execPath, cli: process.execPath }, [
      "-e", "setInterval(()=>{},1000)",
    ], controller.signal), { name: "AbortError" });
  } finally { clearTimeout(timer); }
});
