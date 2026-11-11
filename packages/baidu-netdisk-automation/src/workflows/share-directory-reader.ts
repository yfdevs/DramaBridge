type ShareEntry = {
  path?: string;
  fs_id?: number | string;
  fsid?: number | string;
  id?: number | string;
  [key: string]: unknown;
};

/** Serialized into the share page. Keep independent of module scope. */
export function createBaiduShareDirectoryReader(options: {
  request: (url: string) => Promise<Record<string, unknown>>;
  shareId: string;
  shareUk: string;
  token: string;
  maxPages: number;
  fallbackRoots: ShareEntry[];
  onFailure?: (message: string) => void;
}) {
  const utils = {
    normalize(value: string) {
      return (
        "/" +
        String(value || "")
          .split("/")
          .filter(Boolean)
          .join("/")
      );
    },
    fsId(item: ShareEntry) {
      return String(item.fs_id || item.fsid || item.id || "");
    },
  };
  const aliases = new Map<string, string>();
  const authoritativePaths = new Set<string>();
  const reader = {
    remember(items: ShareEntry[], root: boolean) {
      for (const item of items) if (item.path) authoritativePaths.add(utils.normalize(item.path));
      if (!root) return;
      const byId = new Map(
        items
          .filter((item) => utils.fsId(item) && item.path)
          .map((item) => [utils.fsId(item), utils.normalize(item.path!)]),
      );
      for (const item of options.fallbackRoots) {
        const canonical = byId.get(utils.fsId(item));
        if (item.path && canonical) aliases.set(utils.normalize(item.path), canonical);
      }
    },
    async load(directory: string): Promise<ShareEntry[]> {
      const requested = utils.normalize(directory);
      let dir = requested;
      // Resolve client-rendered aliases only by matching file identity against a
      // fresh share root. Removing a /sharelink prefix guesses the owner's path.
      const alias = [...aliases.keys()]
        .sort((a, b) => b.length - a.length)
        .find((prefix) => dir === prefix || dir.startsWith(prefix + "/"));
      if (alias) dir = aliases.get(alias)! + dir.slice(alias.length);
      if (/^\/sharelink\d+-\d+(?:\/|$)/.test(dir) && !authoritativePaths.has(dir)) {
        throw new Error(
          "分享目录仍是客户端临时路径，未能从分享根目录确认真实路径，已停止转存：" +
            requested +
            "；请重新打开原分享链接后重试",
        );
      }
      const results: ShareEntry[] = [];
      // /share/list can cap a response at 100 even when num=1000 is requested,
      // and omit has_more. Request the supported size so a full page cannot be
      // mistaken for the end of a directory (e.g. 105 episodes read as 100).
      const pageSize = 100;
      const seen = new Set<string>();
      for (let page = 1; page <= options.maxPages; page++) {
        const params = new URLSearchParams({
          uk: options.shareUk,
          shareid: options.shareId,
          root: dir === "/" ? "1" : "0",
          order: "other",
          desc: "1",
          showempty: "0",
          web: "1",
          page: String(page),
          num: String(pageSize),
          t: String(Date.now()),
          channel: "chunlei",
          app_id: "250528",
          bdstoken: options.token,
          clienttype: "0",
        });
        // The root is selected with root=1; dir=/ is not a substitute for it.
        if (dir !== "/") params.set("dir", dir);
        const data = await options.request("/share/list?" + params);
        const code = Number(data.errno ?? data.error_code ?? 0);
        if (code !== 0) {
          const requestId = String(data.request_id ?? data.requestid ?? "")
            .replace(/[^\w-]/g, "")
            .slice(0, 100);
          const detail =
            "errno=" + code + "；" + dir + (requestId ? "；request_id=" + requestId : "");
          options.onFailure?.("page=" + page + " " + detail);
          const hint =
            code === -9
              ? "；分享目录路径或访问状态已失效，请重新打开原分享链接确认目录仍可访问后重试"
              : "";
          throw new Error("读取分享目录失败：" + detail + hint);
        }
        // Never cache a partial/malformed listing as an empty source directory.
        if (!Array.isArray(data.list)) throw new Error("分享目录返回了不完整的文件列表：" + dir);
        const list = data.list as ShareEntry[];
        const fresh = list.filter(item => {
          const key = utils.fsId(item) || String(item.path || "");
          if (!key) throw new Error("分享目录条目缺少文件身份：" + dir);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (list.length && !fresh.length) throw new Error("分享目录分页重复，无法确认完整文件列表：" + dir);
        results.push(...fresh);
        const hasMore = data.has_more === true || Number(data.has_more) === 1;
        if (list.length < pageSize && !hasMore) {
          reader.remember(results, dir === "/");
          return results;
        }
      }
      throw new Error("分享目录分页超出安全上限，已停止转存：" + dir);
    },
  };
  return { load: reader.load };
}
