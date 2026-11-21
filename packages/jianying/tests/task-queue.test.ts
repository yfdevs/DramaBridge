import assert from "node:assert/strict";
import { test } from "node:test";
import { JianyingTaskQueue, type JianyingQueueState } from "../src/task-queue.js";
import { DEFAULT_WORKBENCH_RANGES } from "../src/workbench-settings.js";
const settings={...DEFAULT_WORKBENCH_RANGES,minSeconds:15,maxSeconds:30};
function deferred() { let resolve!:()=>void; const promise=new Promise<void>(done=>{resolve=done;}); return {promise,resolve}; }
async function flush() { for(let i=0;i<10;i++) await Promise.resolve(); }

test("queue runs one drama at a time, supports adding while running, and snapshots settings", async()=>{
  const gates=[deferred(),deferred(),deferred()]; const started:string[]=[];
  const queue=new JianyingTaskQueue([],async task=>{started.push(task.name);await gates[started.length-1].promise;},()=>{});
  const config={...settings}; queue.add("D:/one","one",config); config.minSeconds=6;
  queue.add("D:/two","two",settings); queue.start(); queue.start();
  assert.deepEqual(started,["one"]);
  assert.equal(queue.snapshot().tasks[0].settings.minSeconds,15);
  queue.add("D:/three","three",settings);
  gates[0].resolve(); await flush(); assert.deepEqual(started,["one","two"]);
  gates[1].resolve(); await flush(); assert.deepEqual(started,["one","two","three"]);
  gates[2].resolve(); await flush(); assert.ok(queue.snapshot().tasks.every(task=>task.status==="success"));
  assert.equal(queue.snapshot().running,false);
});
test("pausing lets the current drama settle and blocks the next until resumed", async()=>{
  const gate=deferred(); const started:string[]=[];
  const queue=new JianyingTaskQueue([],async task=>{started.push(task.name);await gate.promise;},()=>{});
  queue.add("D:/one","one",settings);queue.add("D:/two","two",settings);queue.start();queue.pause();
  gate.resolve();await flush();assert.deepEqual(started,["one"]);
  assert.equal(queue.snapshot().tasks[1].status,"waiting");
  queue.start();await flush();assert.deepEqual(started,["one","two"]);
});
test("failure pauses remaining tasks and retry resumes without concurrent execution", async()=>{
  let fail=true;
  const queue=new JianyingTaskQueue([],async()=>{if(fail) throw new Error("desktop failed");},()=>{});
  const first=queue.add("D:/one","one",settings).tasks[0];queue.add("D:/two","two",settings);
  queue.start();await flush();assert.equal(queue.snapshot().tasks[0].status,"failed");
  assert.equal(queue.snapshot().running,false);assert.equal(queue.snapshot().tasks[1].status,"waiting");
  fail=false;queue.retry(first.id);queue.start();await flush();assert.ok(queue.snapshot().tasks.every(task=>task.status==="success"));
});
test("restart preserves jobs without automatically starting desktop automation",async()=>{
  const gate=deferred();const queue=new JianyingTaskQueue([],()=>gate.promise,()=>{});
  queue.add("D:/one","one",settings);queue.start();
  assert.throws(()=>queue.add("d:/ONE","one",settings),/已在队列/);
  assert.throws(()=>queue.remove(queue.snapshot().tasks[0].id),/先停止/);
  const restored=new JianyingTaskQueue(queue.snapshot().tasks,async()=>{throw new Error("must not run");},()=>{});
  assert.equal(restored.snapshot().running,false);assert.equal(restored.snapshot().tasks[0].status,"waiting");
  queue.pause();gate.resolve();await flush();
});
