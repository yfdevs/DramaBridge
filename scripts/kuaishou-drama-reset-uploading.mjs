import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { emitKeypressEvents } from "node:readline";

const prefix = "/dramaAiRpa/kuaishou";
const help = `快手上传中任务重置（Node.js 18+，无需安装依赖）

一键执行：node scripts/kuaishou-drama-reset-uploading.mjs
跳过任务：node scripts/kuaishou-drama-reset-uploading.mjs --skip-ids 1498
只处理指定任务：node scripts/kuaishou-drama-reset-uploading.mjs --ids 1500,1501
仅预览：node scripts/kuaishou-drama-reset-uploading.mjs --dry-run

--base-url URL       默认 http://180.184.76.232:19090
--username NAME      后台登录账号，默认 admin；执行时提示输入隐藏密码
--password-stdin     从标准输入读取密码，用于自动调用；不保存密码或 token
--account-id ID      只处理指定快手账号，默认查询全部快手账号
--ids ID,ID          只处理指定任务；未指定时间参数时不限制其未更新时长
--skip-ids ID,ID     跳过指定任务（优先于 --ids），可简写 --skip
--worker-id ID       可进一步限定原领取执行器
--older-than-hours N 最短未更新时长（按 updateTime），默认 4 小时，支持小数（也接受 --min-age-hours）
--claimed-before T   只处理在此时间之前领取的任务；无时区时按北京时间
--resume-failed      额外允许处理符合筛选条件的 FAILED 任务
--log FILE          操作记录位置，默认 .cache/kuaishou-reset-时间.json
--dry-run           只预览，不修改后台，也不要求登录
--apply             实际执行（默认）；兼容旧版 --confirm-stopped 参数

脚本先保留原 workerId/attemptCount 回写中断失败，再调用后台重试接口。
时间条件是人工重置规则，并非执行器心跳；正在执行的长任务请用 --skip-ids 排除。
自动恢复上次脚本已回写失败但重试未完成的遗留任务。不会重置已成功任务。
不清理本机 SQLite。后台重置后，可在客户端停止服务并
点击对应待核实任务的“已在后台处理，重新检查”，解除本机暂停记录。`;

export function parseResetArgs(args) {
  const options = { baseUrl: "http://180.184.76.232:19090", username: "admin", minAgeHours: 4, ids: [], skipIds: [], apply: true };
  const values = { "--base-url": "baseUrl", "--username": "username", "--account-id": "accountId", "--worker-id": "workerId", "--log": "logFile", "--min-age-hours": "minAgeHours", "--older-than-hours": "minAgeHours", "--claimed-before": "claimedBefore", "--ids": "ids", "--skip-ids": "skipIds", "--skip": "skipIds" };
  const flags = { "--apply": "apply", "--dry-run": "dryRun", "--password-stdin": "passwordStdin", "--confirm-stopped": "confirmStopped", "--resume-failed": "resumeFailed", "--help": "help" };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (flags[arg]) { options[flags[arg]] = true; continue; }
    if (!values[arg] || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`参数无效或缺值：${arg}`);
    const key = values[arg];
    if (key === "minAgeHours") options.ageExplicit = true;
    if (["ids", "skipIds"].includes(key)) options[key] = [...options[key], ...parseIds(args[++index])];
    else options[key] = args[++index];
  }
  if (options.help) return options;
  options.baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  if (!["http:", "https:"].includes(new URL(options.baseUrl).protocol)) throw new Error("后台地址必须是 HTTP/HTTPS");
  options.ids = [...new Set(options.ids)];
  options.skipIds = [...new Set(options.skipIds)];
  options.minAgeHours = Number(options.minAgeHours);
  if (!Number.isFinite(options.minAgeHours) || options.minAgeHours < 0) throw new Error("最短未更新时长必须为非负小时数");
  if (options.claimedBefore && !Number.isFinite(parseClaimTime(options.claimedBefore))) throw new Error("--claimed-before 时间无效");
  options.apply = !options.dryRun;
  return options;
}

function parseIds(value) {
  return value.split(",").map(part => {
    if (!/^\d+$/.test(part.trim()) || !Number.isSafeInteger(Number(part)) || Number(part) <= 0) throw new Error("任务 ID 必须是正整数，以英文逗号分隔");
    return Number(part);
  });
}

function parseClaimTime(raw) {
  if (typeof raw !== "string") return NaN;
  const value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw.replace(" ", "T");
  return Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}+08:00`);
}

export async function loginResetAdmin(baseUrl, { username, password }, fetcher = fetch) {
  const response = await fetcher(`${baseUrl}/user/login`, { method: "POST", redirect: "error", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`后台登录失败：HTTP ${response.status}`);
  const result = await response.json();
  if (result.code !== 0 || result.data?.isLogin === false || !result.data?.tokenName || !result.data?.tokenValue) throw new Error("后台登录失败，请检查账号和密码");
  return { [result.data.tokenName]: result.data.tokenValue };
}

export function createResetApi(baseUrl, fetcher = fetch, authentication = {}) {
  const api = async (endpoint, body) => {
    const response = await fetcher(`${baseUrl}${prefix}${endpoint}`, {
      method: "POST", redirect: "error", headers: { "content-type": "application/json", ...authentication },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${endpoint}`);
    const payload = await response.json();
    if (payload.code !== 0) throw new Error(`${endpoint}: ${payload.msg || `code=${payload.code}`}`);
    return payload.data;
  };
  api.authenticated = Object.keys(authentication).length > 0;
  return api;
}

export async function listResetTasks(api, accountId, status) {
  const found = new Map();
  for (let page = 1; page <= 100; page++) {
    const result = await api("/accountTask/page", { page, pageSize: 100, accountId: accountId || null, status });
    if (!result || !Array.isArray(result.data)) throw new Error("任务分页响应缺少 data 数组，已停止");
    const previousCount = found.size;
    for (const row of result.data) found.set(row.id, row);
    if (result.data.length < 100 || (Number.isInteger(result.total) && page * 100 >= result.total)) return [...found.values()];
    if (found.size === previousCount) throw new Error("后台返回重复分页，已停止");
  }
  throw new Error("任务超过查询范围，已停止");
}

export function taskSnapshot(row) {
  return { id: row.id, accountId: row.accountId, title: row.originalTitle || row.publishTitle,
    status: row.status, workerId: row.rpaWorkerId, attemptCount: row.rpaAttemptCount,
    claimTime: row.rpaClaimTime, updateTime: row.updateTime };
}

export function resetEligibility(row, options, now = Date.now()) {
  if (row.platform && row.platform !== "KUAISHOU") return "不是快手任务";
  if (options.accountId && row.accountId !== options.accountId) return "账号不匹配";
  if (options.skipIds?.includes(row.id)) return "在跳过列表中";
  if (options.ids.length && !options.ids.includes(row.id)) return "不在指定 ID 中";
  if (options.workerId && row.rpaWorkerId !== options.workerId) return "执行器不匹配";
  const recoverFailed = options.resumeFailed || options.ids.includes(row.id) || row.lastErrorMessage?.startsWith("人工重置已中断的快手执行任务");
  if (row.status !== "UPLOADING" && !(recoverFailed && row.status === "FAILED")) return "当前状态不可重置";
  if (!row.rpaWorkerId?.trim() || !Number.isSafeInteger(row.rpaAttemptCount) || row.rpaAttemptCount <= 0) return "缺少有效的领取者或轮次，需人工核实";
  // The backend's zone-less timestamps are Asia/Shanghai, independent of this computer's zone.
  const claimed = parseClaimTime(row.rpaClaimTime);
  const updated = parseClaimTime(row.updateTime);
  const minAge = options.ids.length && !options.ageExplicit ? 0 : options.minAgeHours;
  if (!Number.isFinite(updated) || updated > now || now - updated < minAge * 3_600_000) return "更新时间无效或未达到最短时长";
  if (!Number.isFinite(claimed)) return "领取时间无效，需人工核实";
  if (options.claimedBefore && claimed >= parseClaimTime(options.claimedBefore)) return "不早于指定领取时间";
  return null;
}

export async function resetKuaishouTasks(options, { api = createResetApi(options.baseUrl), now = Date.now(), checkpoint = async () => {} } = {}) {
  // Validate again for programmatic callers, before any mutation.
  if (options.apply && api.authenticated === false) throw new Error("请先登录后台再执行重置，尚未修改任何任务");
  let rows = await listResetTasks(api, options.accountId, "UPLOADING");
  rows.push(...(await listResetTasks(api, options.accountId, "FAILED")).filter(row => options.resumeFailed || options.ids.includes(row.id) || row.lastErrorMessage?.startsWith("人工重置已中断的快手执行任务")));
  if (options.ids.length) rows = rows.filter(row => options.ids.includes(row.id));
  const journal = { baseUrl: options.baseUrl, mode: options.apply ? "apply" : "preview", createdAt: new Date(now).toISOString(),
    filters: { accountId: options.accountId, ids: options.ids, skipIds: options.skipIds, workerId: options.workerId, minAgeHours: options.minAgeHours, ageExplicit: options.ageExplicit, claimedBefore: options.claimedBefore },
    tasks: [], missingIds: options.ids.filter(id => !rows.some(row => row.id === id)) };
  for (const row of rows) {
    const reason = resetEligibility(row, options, now);
    journal.tasks.push({ ...taskSnapshot(row), action: reason ? "skipped" : "eligible", reason });
  }
  await checkpoint(journal);
  if (!options.apply) return journal;
  for (const item of journal.tasks) {
    if (item.action !== "eligible") continue;
    try {
      // Re-read immediately before writing. The report endpoint also fences writes by owner + round.
      const current = (await listResetTasks(api, item.accountId, null)).find(row => row.id === item.id);
      if (!current || resetEligibility(current, options, now) || current.status !== item.status || current.rpaWorkerId !== item.workerId || current.rpaAttemptCount !== item.attemptCount || current.rpaClaimTime !== item.claimTime || current.updateTime !== item.updateTime) {
        item.action = "skipped"; item.reason = "任务状态或领取身份已变化"; await checkpoint(journal); continue;
      }
      if (current.status === "UPLOADING") {
        item.action = "reporting-interruption"; await checkpoint(journal);
        const reported = await api("/rpa/report", { taskId: item.id, workerId: item.workerId, attemptCount: item.attemptCount,
          success: false, failStage: "OTHER", errorMessage: "人工重置已中断的快手执行任务；平台可能已提交部分版本，重新执行时需按精确剧名核实并跳过已提交版本。" });
        if (reported !== true) throw new Error("后台未确认失败回写，禁止继续重试");
        item.action = "reported-failed"; await checkpoint(journal);
      }
      const failed = (await listResetTasks(api, item.accountId, null)).find(row => row.id === item.id);
      if (!failed || failed.status !== "FAILED" || failed.rpaWorkerId !== item.workerId || failed.rpaAttemptCount !== item.attemptCount) throw new Error("回写后状态或领取身份不符合预期，禁止调用重试");
      item.action = "retrying"; await checkpoint(journal);
      if (await api(`/accountTask/retry/${item.id}`) !== true) throw new Error("后台未确认重试成功");
      const result = (await listResetTasks(api, item.accountId, null)).find(row => row.id === item.id);
      if (!result || !(result.status === "READY" || (result.status === "UPLOADING" && result.rpaAttemptCount > item.attemptCount))) throw new Error(`重试后未确认可领取状态：${result?.status || "未找到"}`);
      item.action = "reset"; item.resultStatus = result.status;
      await checkpoint(journal);
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
      await checkpoint(journal);
      throw new Error(`任务 ${item.id} 处理未完成（${item.action}）：${item.error}。已停止后续操作，请核实日志；可用 --resume-failed 继续已回写失败的任务。`);
    }
  }
  return journal;
}

async function readPassword(fromStdin) {
  if (fromStdin) {
    if (process.stdin.isTTY) throw new Error("--password-stdin 需要通过管道输入密码；交互运行请去掉此参数");
    let value = "";
    for await (const chunk of process.stdin) value += chunk.toString();
    // Windows PowerShell may prepend a UTF-8 BOM to native-command pipelines.
    return value.replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
  }
  if (!process.stdin.isTTY) throw new Error("请在终端运行以输入隐藏密码，或使用 --password-stdin；尚未修改后台");
  emitKeypressEvents(process.stdin);
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    const finish = (error) => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === "c") finish(new Error("已取消，尚未修改后台"));
      else if (key.name === "return" || key.name === "enter") finish();
      else if (key.name === "backspace") value = [...value].slice(0, -1).join("");
      else if (text && !key.ctrl && !key.meta) value += text;
    };
    process.stdout.write("后台密码（不回显、不保存）：");
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
  });
}

async function main() {
  const options = parseResetArgs(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  let authentication = {};
  if (options.apply) {
    const password = await readPassword(options.passwordStdin);
    if (!password) throw new Error("密码不能为空，尚未修改后台");
    authentication = await loginResetAdmin(options.baseUrl, { username: options.username, password });
    console.log(`后台登录成功。${options.ids.length && !options.ageExplicit ? "仅处理指定任务 ID。" : `处理未更新超过 ${options.minAgeHours} 小时的任务。`}`);
  }
  const filename = path.resolve(options.logFile || `.cache/kuaishou-reset-${Date.now()}.json`);
  await mkdir(path.dirname(filename), { recursive: true });
  // Audit records are operation artifacts, not app configuration. Never overwrite an existing log.
  await writeFile(filename, "{}", { flag: "wx" });
  console.log(`${options.apply ? "执行重置" : "仅预览，不修改后台"}；操作记录：${filename}`);
  const result = await resetKuaishouTasks(options, { api: createResetApi(options.baseUrl, fetch, authentication), checkpoint: journal => writeFile(filename, JSON.stringify(journal, null, 2)) });
  console.table(result.tasks.map(({ id, title, status, claimTime, updateTime, action, reason, resultStatus }) => ({ id, title, status, claimTime, updateTime, action, reason, resultStatus })));
  if (result.missingIds.length) console.log(`这些 ID 不在当前候选状态内，未修改：${result.missingIds.join(",")}`);
  console.log(options.apply ? `已重置 ${result.tasks.filter(task => task.action === "reset").length} 条任务。` : "本次仅预览；去掉 --dry-run 并登录后台后执行。正在执行的长任务请用 --skip-ids 排除。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
