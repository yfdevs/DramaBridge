import assert from "node:assert/strict";
import test from "node:test";
import { youtubeTaskFailure } from "../src/pages/youtube-drama/task-failure";
import type { YoutubeTask } from "../src/platforms/youtube-drama/service";

test("old exit-code failures expose authorization cause without showing raw logs", () => {
  const task = {error: "分离 / 上传程序退出，代码 1。请查看下方执行日志后重试", logs:
    "开始 / 恢复任务\n已生成视频\ntoken 已失效，需要重新授权…", progress: {stage: "authorizing"}} as YoutubeTask;
  const failure = youtubeTaskFailure(task)!;
  assert.equal(failure.code, "AUTH_INVALID");
  assert.match(failure.action, /账号管理/);
  assert.doesNotMatch(failure.reason + failure.action, /下方|执行日志/);
  assert.equal(youtubeTaskFailure({...task,error:null}), null);
});

test("old messages from earlier attempts do not mislabel the latest failure", () => {
  const task = {error:"分离 / 上传程序退出，代码 1",logs:
    "开始 / 恢复任务\ninvalid_grant\n开始 / 恢复任务\nunknown error"} as YoutubeTask;
  assert.equal(youtubeTaskFailure(task)?.code, "PROCESS_FAILED");
  const structured = {code:"NETWORK_ERROR",title:"连接失败",reason:"网络中断",action:"检查代理"};
  assert.deepEqual(youtubeTaskFailure({...task,progress:{failure:structured}}), structured);
});
