type Entry = Record<string, any>;

/** Serialized into the authenticated share page. No module-scope dependencies. */
export async function transferNormalizedEpisodeVideos(o: {
  versionTitle?: string; recreation?: boolean; parentDirectoryName?: string; title: string; episodeCount: number; roots: Entry[]; sharePassword?: string;
  listShare: (path: string) => Promise<Entry[]>;
  listOwn: (path: string, refresh?: boolean) => Promise<Entry[]>;
  createDirectory: (parent: string, name: string) => Promise<Entry>;
  transferOne: (source: Entry, dest: string, materialKind?: "video" | "cover") => Promise<{ item: Entry; transferred: boolean }>;
  request: (url: string, init: unknown) => Promise<Entry>; token: string;
  identical: (a: Entry, b: Entry) => boolean;
  compare: (a: any, b: any) => number;
  subtitlePreference: (path: string) => number;
  collapseAliases: (files: any[]) => { files: any[] };
  episodeIndex: (name: string) => number | undefined;
}) {
  const name = (e: Entry) => String(e.server_filename || e.filename || e.path?.split('/').pop() || '');
  const isDir = (e: Entry) => Number(e.isdir ?? e.is_dir ?? 0) === 1;
  const id = (e: Entry) => String(e.fs_id || e.fsid || e.id || '');
  const total = o.recreation ? Math.ceil(o.episodeCount * 0.6) : o.episodeCount;
  const progress = (completed: number, stage: string) => console.log('[baidu-video-progress] ' + JSON.stringify({ completed, total, stage }));
  progress(0, '扫描视频');
  const queue = [{ path: '/', entries: o.roots, depth: 0 }];
  const visited = new Set<string>();
  const candidates: any[] = [];
  const covers: Entry[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current.path)) continue;
    visited.add(current.path);
    if (visited.size > 300 || current.depth > 10) throw new Error('分享目录过深或过多，已停止转存');
    if (o.recreation) covers.push(...current.entries.filter(e => !isDir(e) && /\.(png|jpg|jpeg|webp)$/i.test(name(e)) && /封面|海报|poster|cover/i.test(current.path + "/" + name(e))));
    const videos = current.entries.filter(e => !isDir(e) && /\.(mp4|mov)$/i.test(name(e)));
    const files = o.collapseAliases(videos.map(e => ({ ...e, index: o.episodeIndex(name(e)) ?? 0, name: name(e),
      path: String(e.path), fsId: id(e), contentHash: e.md5 || e.server_md5 }))).files;
    const ordered = files.sort((a, b) => a.index - b.index);
    const valid = ordered.length === o.episodeCount && ordered.every((e, i) => e.index === i + 1);
    if (valid) candidates.push({ path: current.path, files: ordered, validEpisodeSequence: true,
      materialDirectory: /权属|版权|工程|素材|花絮|预告/.test(current.path),
      subtitlePreference: o.subtitlePreference(current.path), preferredEpisodeDirectory: /视频|成片|正片/.test(current.path),
      uniqueEpisodeCount: files.length, recognizedVideoCount: files.length,
      mp4Count: files.filter(e => /\.mp4$/i.test(e.name)).length, depth: current.depth });
    for (const entry of current.entries.filter(isDir)) queue.push({ path: String(entry.path),
      entries: await o.listShare(String(entry.path)), depth: current.depth + 1 });
  }
  // Subtitle choice takes priority among complete episode sets, even if a
  // publisher nests its subtitled version deeper than its clean version.
  candidates.sort((a, b) => b.subtitlePreference - a.subtitlePreference || o.compare(a, b));
  const selected = candidates[0];
  if (!selected) throw new Error(`未找到完整且集号唯一的 ${o.episodeCount} 集视频目录，未转存任何文件`);
  if (selected.files.some((e: Entry) => !/\.mp4$/i.test(e.name))) {
    throw new Error('选中的全集包含 MOV 文件，云端改名不能转换视频格式，已停止转存');
  }
  const coverIds: string[] = [];
  progress(0, '转存视频');
  const parent = o.parentDirectoryName ? await o.createDirectory('/', o.parentDirectoryName) : undefined;
  const parentPath = parent ? String(parent.path || '/' + o.parentDirectoryName) : '/';
  const root = await o.createDirectory(parentPath, o.recreation && !o.versionTitle ? o.title + '60%素材' : o.title);
  let rootPath = String(root.path || parentPath.replace(/\/$/, '') + '/' + o.title);
  let shareRoot = root;
  let shareRootPath = rootPath;
  const shareChildren: Entry[] = [];
  if (o.recreation) {
    if (o.versionTitle) {
      const version = await o.createDirectory(rootPath, o.versionTitle + '-60%');
      rootPath = String(version.path);
      shareRoot = version;
      shareRootPath = rootPath;
    }
    const cover = await o.createDirectory(rootPath, '封面');
    shareChildren.push(cover);
    for (const image of covers) {
      const copied = await o.transferOne(image, String(cover.path), "cover");
      if (!o.identical(image, copied.item)) throw new Error('封面转存文件身份未确认：' + name(image));
      coverIds.push(id(copied.item));
    }
    const videos = await o.createDirectory(rootPath, '成片60%');
    shareChildren.push(videos);
    rootPath = String(videos.path);
    selected.files = selected.files.slice(0, Math.ceil(o.episodeCount * 0.6));
  }
  let transferredItemCount = 0;
  const results: Entry[] = [];
  // Validate every target before the first write. Never overwrite another drama's file.
  const existing = await o.listOwn(rootPath, true);
  for (const file of selected.files) {
    const targetName = `${o.versionTitle || o.title}-第${file.index}集.mp4`;
    const collision = existing.find(e => name(e) === targetName);
    if (collision && !o.identical(file, collision)) throw new Error('目标文件内容冲突：' + rootPath + '/' + targetName);
  }
  for (const file of selected.files) {
    const targetName = `${o.versionTitle || o.title}-第${file.index}集.mp4`;
    let target = (await o.listOwn(rootPath, true)).find(e => name(e) === targetName);
    if (!target) {
      const copied = await o.transferOne(file, rootPath);
      if (!o.identical(file, copied.item)) throw new Error('转存文件身份未确认：' + file.name);
      if (copied.transferred) transferredItemCount++;
      if (name(copied.item) !== targetName) {
        const params = new URLSearchParams({ opera: 'rename', async: '0', ondup: 'fail',
          channel: 'chunlei', web: '1', app_id: '250528', clienttype: '0', bdstoken: o.token });
        const response = await o.request('/api/filemanager?' + params, { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: new URLSearchParams({ filelist: JSON.stringify([{ path: copied.item.path, newname: targetName }]) }) });
        if (Number(response.errno) !== 0) throw new Error('视频改名失败：' + targetName + '；errno=' + response.errno);
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        target = (await o.listOwn(rootPath, true)).find(e => name(e) === targetName);
        if (target) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    if (!target || !o.identical(file, target)) throw new Error('目标视频未通过内容核验：' + targetName);
    results.push({ index: file.index, name: targetName, path: target.path, fsId: id(target), size: target.size });
    progress(results.length, '转存视频');
    console.log(`[baidu-transfer] 已确认第${file.index}/${o.episodeCount}集：${targetName}`);
  }
  let shareUrl = '';
  if (o.sharePassword) {
    progress(results.length, '生成分享链接');
    // Sharing individual file IDs flattens covers and videos in the public link.
    // Share the task directory only after verifying its entire contents.
    const assertContents = async (path: string, expected: string[]) => {
      if (expected.some(value => !value)) throw new Error('文件缺少 ID，无法创建分享');
      const wanted = new Set(expected);
      const actual = await o.listOwn(path, true);
      if (actual.length !== wanted.size || actual.some(entry => !wanted.has(id(entry))))
        throw new Error('任务目录含有本次任务以外的内容，未创建分享：' + path);
    };
    if (o.recreation) {
      await assertContents(shareRootPath, shareChildren.map(id));
      await assertContents(String(shareChildren[0].path), coverIds);
    }
    await assertContents(rootPath, results.map(file => file.fsId));
    const ids = [id(shareRoot)];
    if (!ids[0]) throw new Error('任务文件夹缺少 ID，无法创建分享');
    const params = new URLSearchParams({ channel: 'chunlei', web: '1', app_id: '250528', clienttype: '0', bdstoken: o.token });
    const shared = await o.request('/share/set?' + params, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ fid_list: JSON.stringify(ids), schannel: '4', channel_list: '[]', period: '0', pwd: o.sharePassword }) });
    if (Number(shared.errno) !== 0 || !shared.shareid || typeof shared.link !== 'string') throw new Error('视频已转存，生成分享链接失败；请重试核验已有文件后补建链接');
    const url = new URL(shared.link);
    if (url.hostname !== 'pan.baidu.com' || !/^https?:$/.test(url.protocol) || !url.pathname.startsWith('/s/')) throw new Error('百度网盘返回的分享链接无效');
    url.protocol = 'https:'; url.searchParams.set('pwd', o.sharePassword); shareUrl = url.toString();
  }
  return { resourceRootPath: shareRootPath, resourceRootName: o.versionTitle || o.title, resourceRootFsId: id(shareRoot),
    savedPath: shareRootPath, fileName: o.versionTitle || o.title, fsId: id(shareRoot), transferredItemCount, shareUrl,
    remoteVideos: { rootPath, files: results } };
}
