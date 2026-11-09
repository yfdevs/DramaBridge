import os from "node:os";
import path from "node:path";

// 百度网盘客户端 CDP 调试服务监听地址。
export const debugHost = "127.0.0.1";

// 单次 CDP/HTTP 请求超时时间，避免客户端无响应时长期卡住。
export const requestTimeoutMs = 2500;

// 未显式传入下载目录时使用的本地默认下载目录。
export const DEFAULT_BAIDU_NETDISK_DOWNLOAD_DIR = process.platform === "win32"
  ? "D:\\BaiduNetdiskDownload"
  : path.join(os.homedir(), "Downloads", "DramaBridge");

// 分享文本未解析到标题时使用的兜底分享名称。
export const DEFAULT_BAIDU_NETDISK_SHARE_NAME = "百度网盘分享";

// 读取分享文件列表时最多翻页次数，防止异常分享导致无限分页。
export const SHARE_LIST_MAX_PAGES = 20;

// “我的网盘”中查找已保存目录时最多记录的尝试日志数量。
export const OWN_NETDISK_ATTEMPT_LOG_LIMIT = 12;

// 扫描“我的网盘”目录列表时最多翻页次数。
export const OWN_NETDISK_DIR_LIST_MAX_PAGES = 30;

// 百度客户端内置 /api/list 对较大的 num 偶发返回 errno=1，保持接近网页默认页量。
export const OWN_NETDISK_DIR_LIST_PAGE_SIZE = 100;

// 远程目录详情日志中最多展示的子项数量。
export const REMOTE_DIR_ENTRY_SAMPLE_LIMIT = 10;

// 从分享根目录向下扫描视频目录时允许进入的最大目录深度。
export const REMOTE_VIDEO_SCAN_MAX_DEPTH = 3;

// 从分享根目录向下扫描视频目录时最多检查的目录数量。
export const REMOTE_VIDEO_SCAN_MAX_DIRS = 100;

// 修改百度网盘下载设置时最多重试次数。
export const DOWNLOAD_SETTING_MAX_ATTEMPTS = 50;
