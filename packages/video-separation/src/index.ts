import { readdir, mkdir, readFile, stat, rename, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { resolveFfmpegExecutablePath, resolveFfprobeExecutablePath, readVideoDurationSeconds } from "@dramabridge/media-assets";
import { matchBaiduEpisodeIndex } from "../../baidu-netdisk-automation/src/workflows/episode-index.js";

export async function scanEpisodes(directory: string) {
  const files = (await readdir(directory, { withFileTypes: true })).filter(e => e.isFile() && /\.(mp4|mov|mkv|m4v)$/i.test(e.name))
    .map(e => ({ name: e.name, index: matchBaiduEpisodeIndex(e.name), path: path.join(directory, e.name) }))
    .filter((e): e is typeof e & { index: number } => e.index !== undefined).sort((a,b) => a.index-b.index);
  if (!files.length) throw new Error("目录中没有匹配到剧集视频");
  if (new Set(files.map(e => e.index)).size !== files.length) throw new Error("目录存在重复集号，请只保留一个视频版本");
  return files;
}
export function segmentPlan(duration: number, seconds: number) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error("时长无效（每集须为 1–3600 秒）");
  const count = Math.max(1, Math.floor((duration + 0.001) / seconds));
  return Array.from({length: count}, (_, i) => ({start: i * seconds, duration: i === count - 1 ? duration - i * seconds : seconds}));
}
type Log = (message: string, details?: Record<string, unknown>) => void;
async function ffmpeg(args: string[], log: Log) {
  const started = Date.now();
  const executable = resolveFfmpegExecutablePath();
  log('FFmpeg 开始', {executable, args});
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner','-nostdin','-progress','pipe:1','-stats_period','5','-n',...args], { windowsHide: true });
    let error = ''; let buffer = ''; let metrics: Record<string,string> = {};
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      for (const line of lines) {
        const index = line.indexOf('='); if (index < 0) continue;
        metrics[line.slice(0,index)] = line.slice(index+1);
        if (line.startsWith('progress=')) {
          log('FFmpeg 进度', {output: args[args.length - 1], elapsedSeconds: (Date.now()-started)/1000, ...metrics}); metrics = {};
        }
      }
    });
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-4000); });
    child.on('error', e => {log('FFmpeg 启动失败',{error:String(e)});reject(e);});
    child.on('close', code => {
      log('FFmpeg 结束', {output:args[args.length - 1], exitCode:code, elapsedSeconds:(Date.now()-started)/1000, ...(code ? {error} : {})});
      code === 0 ? resolve() : reject(new Error(error));
    });
  });
}
export async function separateVideos(directory: string, seconds: number, progress: (message: string) => void | Promise<void> = () => {}, log: Log = (message, detail) => console.log("[video-separation]", message, detail ?? "")) {
  const started = Date.now();
  log("任务开始", {directory,seconds});
  const runFfmpeg = (args: string[]) => ffmpeg(args, log);
  segmentPlan(1, seconds);
  const files = await scanEpisodes(directory);
  log("目录扫描完成", {episodes:files.length,elapsedSeconds:(Date.now()-started)/1000});
  const sourceDirectory = path.resolve(directory);
  const output = path.join(path.dirname(sourceDirectory), path.basename(sourceDirectory) + '-视频分离' + seconds + 's');
  await mkdir(output, {recursive:true});
  const fingerprint = createHash('sha256').update(JSON.stringify(await Promise.all(files.map(async file => {
    const info = await stat(file.path);
    return [file.path, info.size, info.mtimeMs];
  })))).digest('hex');
  const work = path.join(output, '.video-separation-cache');
  await mkdir(work, {recursive:true});
  const manifestPath = path.join(work, 'manifest.json');
  let manifest: { fingerprint: string; seconds: number; duration?: number } | undefined;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('续跑记录损坏，请检查输出目录：' + output);
  }
  if (manifest && (manifest.fingerprint !== fingerprint || manifest.seconds !== seconds))
    throw new Error('源视频或秒数已变化，请移动已有输出目录后重新处理，避免混用旧分集');
  const merged = path.join(work,'merged.mp4');
  const validDuration = async (file: string, expected?: number) => {
    try {
      const duration = await readVideoDurationSeconds(file);
      return Number.isFinite(duration) && duration > 0 && (expected === undefined || Math.abs(duration - expected) <= 0.15) ? duration : undefined;
    } catch { return undefined; }
  };
  // An interrupted merge is never published under the final cache filename.
  let duration = manifest?.duration ? await validDuration(merged, manifest.duration) : undefined;
  if (!duration) {
    await progress('正在合并视频');
    const list = path.join(work, 'inputs.txt');
    await writeFile(list, files.map(e => "file '" + e.path.replace(/\\/g,'/').replace(/'/g, "'\\''") + "'").join('\n'));
    const temporary = path.join(work, 'merged.partial.mp4');
    await rm(temporary, {force:true});
    const signatures: string[] = [];
    for (const file of files) {
      const {stdout} = await promisify(execFile)(resolveFfprobeExecutablePath(), ['-v','error','-show_data_hash','sha256','-show_entries','stream=codec_type,codec_name,width,height,pix_fmt,profile,level,extradata_hash,r_frame_rate,time_base,sample_aspect_ratio,sample_rate,channels,channel_layout','-of','json',file.path], {windowsHide:true});
      const streams = JSON.parse(stdout).streams;
      signatures.push(JSON.stringify(['video','audio'].map(kind => streams.find((stream: {codec_type:string}) => stream.codec_type === kind))));
    }
    const compatible = signatures.every(signature => signature === signatures[0]);
    let copied = false;
    if (compatible) {
      try {
        log('编码参数一致，使用无损合并', {episodes:files.length});
        await runFfmpeg(['-f','concat','-safe','0','-auto_convert','1','-i',list,'-map','0:v:0','-map','0:a:0?','-c','copy',temporary]);
        await runFfmpeg(['-v','error','-xerror','-i',temporary,'-map','0:v:0','-map','0:a:0?','-f','null','-']);
        copied = true;
      } catch (error) { log('无损合并校验失败，回退编码', {error:String(error)}); await rm(temporary,{force:true}); }
    }
    if (!copied) {
      const streams = signatures.map(signature => JSON.parse(signature));
      const groups = new Map<string, number>();
      for (const [video] of streams) {
        const key = JSON.stringify(video); groups.set(key, (groups.get(key) || 0) + 1);
      }
      const majority = [...groups].sort((a,b)=>b[1]-a[1])[0][0];
      const target = JSON.parse(majority);
      if (!target?.width || !target?.height) throw new Error('无法读取视频规格');
      const width = target.width % 2 ? target.width + 1 : target.width;
      const height = target.height % 2 ? target.height + 1 : target.height;
      const rate = target.r_frame_rate && target.r_frame_rate !== '0/0' ? target.r_frame_rate : '30';
      const cpu = ['-c:v','libx264','-preset','veryfast','-crf','18'];
      let encoder = cpu;
      for (const candidate of [
        ['-c:v','h264_nvenc','-preset','p4','-cq','20','-b:v','0'],
        ['-c:v','h264_qsv','-preset','veryfast','-global_quality','20'],
        ['-c:v','h264_amf','-quality','balanced','-rc','cqp','-qp_i','20','-qp_p','22'],
      ]) {
        try {
          await runFfmpeg(['-v','error','-f','lavfi','-i',`color=c=black:s=${width}x${height}:r=${rate}`,'-frames:v','2','-vf','format=nv12',...candidate,'-f','null','-']);
          encoder = candidate; break;
        } catch { /* Missing hardware or driver: try the next encoder. */ }
      }
      log('逐集规范化计划', {encoder:encoder[1], width,height,rate, episodes:files.length});
      const normalized: string[] = [];
      for (const [index,file] of files.entries()) {
        await progress(`正在准备合并 ${index+1}/${files.length}`);
        const destination = path.join(work, `normalized-${index+1}.mp4`);
        await rm(destination,{force:true});
        // Keep matching H.264 video packets; normalize only audio/timebase.
        // HEVC parameter sets and other codecs are normalized consistently.
        const copyVideo = !compatible && target.codec_name === 'h264' && JSON.stringify(streams[index][0]) === majority;
        const audio = streams[index][1];
        const input = ['-i',file.path,...(!audio ? ['-f','lavfi','-i','anullsrc=r=48000:cl=stereo'] : [])];
        const encode = async (selectedEncoder: string[]) => runFfmpeg([...input,'-map','0:v:0','-map',audio ? '0:a:0' : '1:a:0',
          ...(copyVideo ? ['-c:v','copy'] : ['-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${rate},format=yuv420p`,...selectedEncoder]),
          '-video_track_timescale','90000','-c:a','aac','-ar','48000','-ac','2','-shortest',destination]);
        log('准备单集', {episode:index+1,video:copyVideo ? 'copy' : encoder[1]});
        try { await encode(encoder); } catch(error) {
          if (encoder === cpu || copyVideo) throw error;
          log('硬件编码失败，回退 CPU',{episode:index+1,error:String(error)});
          await rm(destination,{force:true}); await encode(cpu); encoder = cpu;
        }
        normalized.push(destination);
      }
      await writeFile(list, normalized.map(file => "file '" + file.replace(/\\/g,'/').replace(/'/g, "'\\''") + "'").join('\n'));
      await runFfmpeg(['-f','concat','-safe','0','-auto_convert','1','-i',list,'-map','0:v:0','-map','0:a:0','-c','copy',temporary]);
      await runFfmpeg(['-v','error','-xerror','-i',temporary,'-map','0:v:0','-map','0:a:0','-f','null','-']);
    }
    duration = await validDuration(temporary);
    if (!duration) throw new Error('合并结果无效，请重试');
    await rm(merged, {force:true});
    await rename(temporary, merged);
    await writeFile(manifestPath, JSON.stringify({fingerprint,seconds,duration}));
  }
  log("合并结果就绪", {duration, reused: Boolean(manifest?.duration)});
  const plan = segmentPlan(duration, seconds);
  for (const [i, part] of plan.entries()) {
    const target = path.join(output, `第${i+1}集.mp4`);
    if (await validDuration(target, part.duration)) {
      log("复用已有分集", {episode:i+1, total:plan.length});
      await progress(`已核验并跳过 ${i+1}/${plan.length}`);
      continue;
    }
    await progress(`正在补充分离 ${i+1}/${plan.length}`);
    const temporary = path.join(work, `第${i+1}集.partial.mp4`);
    await rm(temporary, {force:true});
    await runFfmpeg(['-ss',String(part.start),'-i',merged,'-t',String(part.duration),'-map','0:v:0','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-crf','18','-c:a','aac','-movflags','+faststart',temporary]);
    if (!await validDuration(temporary, part.duration)) throw new Error(`第${i+1}集时长校验失败，请重试`);
    await rm(target, {force:true});
    await rename(temporary, target);
  }
  log("任务完成", {output,count:plan.length,elapsedSeconds:(Date.now()-started)/1000});
  return {output, count: plan.length};
}

