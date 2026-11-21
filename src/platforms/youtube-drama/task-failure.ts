import type { YoutubeTask, YoutubeTaskFailure } from "./service";

export function youtubeTaskFailure(task: YoutubeTask): YoutubeTaskFailure | null {
  if (!task.error) return null;
  const saved = task.progress?.failure;
  if (saved && !["PROCESS_FAILED", "QUOTA_EXCEEDED"].includes(saved.code)) return saved;
  // Older workers retained the useful message only in logs. Surface the cause,
  // without restoring a raw-log panel or presenting unrelated earlier attempts.
  const generic = /程序退出.*代码|处理程序异常退出/.test(task.error);
  const attempt = (task.logs ?? "").split("开始 / 恢复任务").pop() ?? "";
  const source = generic ? attempt : task.error;
  const quotaSource = [saved?.detail, source, saved ? attempt : ""].filter(Boolean).join("\n");
  if (/video uploads per day/i.test(quotaSource)) {
    return {
      ...saved,
      code: "UPLOAD_DAILY_QUOTA_EXCEEDED",
      title: "YouTube 今日上传额度已用完",
      reason: "当前 Google API 项目的每日视频上传额度已耗尽。使用同一项目的多个频道共用这份额度。",
      action:
        "请暂停重试，等每日额度恢复后继续。额度按美国太平洋时间午夜重置（北京时间夏令时15:00、冬令时16:00）。可在 Google Cloud 控制台查看 Video Uploads per day 配额；长期不足时申请提高配额。重新登录或换用同一项目下的频道无法恢复额度。",
      stage: "uploading",
    };
  }
  if (saved) return saved;
  if (/上传会话无法恢复|上传会话已失效|无法安全恢复上传/.test(source)) {
    return {
      code: "UPLOAD_SESSION_INVALID",
      title: "上传会话无法恢复",
      reason: "原上传会话已失效、未完整保存，或待上传文件已变化，无法安全续传。",
      action: "先到该账号的 YouTube Studio 核对视频是否已上传，再处理原上传会话，避免重复上传。",
      stage: "uploading",
    };
  }
  if (/invalid_grant|token 已失效|授权缺失或已失效|授权已失效/.test(source)) {
    return {
      code: "AUTH_INVALID",
      title: "账号授权已失效",
      reason: "当前账号授权无法刷新，可能已过期或被撤销。",
      action: "到账号管理更新该账号的授权，测试通过后重试。",
      stage: "authorizing",
    };
  }
  return {
    code: "PROCESS_FAILED",
    title: generic ? "处理程序异常退出" : task.error,
    reason: generic ? "处理程序未正常完成，旧版记录没有保存明确的错误原因。" : "任务未能完成。",
    action: generic
      ? "更新服务后重试；若仍失败，请提供任务编号和错误详情。"
      : "检查错误原因并处理后重试。",
    stage: task.progress?.stage,
  };
}
