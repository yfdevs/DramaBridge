import { execFile } from 'node:child_process';
import { safeFileName, walkFiles } from '@dramabridge/file-utils';
import { existsSync } from 'node:fs';
import { mkdir, readdir, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);
const maxCoverBytes = 10 * 1024 * 1024;
const coverDownloadTimeoutMs = 30_000;
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export type EpisodeFile = { episode: number; file: string };

export async function matchVideos(videoRoot: string, originalTitle: string, episodeCount: number): Promise<EpisodeFile[]> {
  if (!videoRoot.trim()) throw new Error('video root is required');

  const videoDir = path.join(videoRoot, originalTitle);
  if (!existsSync(videoDir)) throw new Error(`video directory not found: ${videoDir}`);
  const files = await walkEpisodeVideoCandidates(videoDir);
  const escapedOriginalTitle = escapeRegExp(originalTitle);
  const episodeFileNamePatterns = [
    new RegExp(`^${escapedOriginalTitle}\\s*[-_—–]?\\s*第\\s*(\\d+)\\s*集\\.(?:mp4|mov)$`, 'i'),
    new RegExp(`^${escapedOriginalTitle}\\s*(\\d+)\\.(?:mp4|mov)$`, 'i'),
  ];
  const episodes = new Map<number, string>();

  for (const file of files) {
    const baseName = path.basename(file);
    const match = episodeFileNamePatterns
      .map(pattern => pattern.exec(baseName))
      .find((result): result is RegExpExecArray => result !== null);
    if (!match) continue;
    const fileSize = (await lstat(file)).size;
    if (fileSize < 5 * 1024 * 1024) throw new Error(`video file too small: ${file} (${fileSize} bytes, need >= 5242880)`);
    const episode = Number(match[1]);
    if (episodes.has(episode)) throw new Error(`duplicate episode ${episode}: ${episodes.get(episode)} / ${file}`);
    episodes.set(episode, file);
  }

  const missing = Array.from({ length: episodeCount }, (_, i) => i + 1).filter(n => !episodes.has(n));
  if (missing.length) throw new Error(`missing episodes: ${missing.join(', ')}`);
  if (episodes.size !== episodeCount) throw new Error(`episode count mismatch: expected ${episodeCount}, got ${episodes.size}`);

  return [...episodes.entries()].sort(([a], [b]) => a - b).map(([episode, file]) => ({ episode, file }));
}

async function walkEpisodeVideoCandidates(videoDir: string): Promise<string[]> {
  const candidates: string[] = [];
  const entries = await readdir(videoDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(videoDir, entry.name);
    if (entry.isFile() && isVideoFile(fullPath)) candidates.push(fullPath);
    if (entry.isDirectory() && ['成片', '成品', '视频'].includes(entry.name)) {
      candidates.push(...(await walkFiles(fullPath)).filter(isVideoFile));
    }
  }

  return candidates;
}

export async function resolveCoverFile(coverFile: string, taskId: string) {
  if (!/^https?:\/\//i.test(coverFile)) {
    if (!existsSync(coverFile)) throw new Error(`coverFile not found: ${coverFile}`);
    await assertCoverSize(coverFile);
    return await normalizeCover(coverFile);
  }

  const url = new URL(coverFile);
  const file = coverDownloadPath(taskId, url);
  await mkdir(path.dirname(file), { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(coverDownloadTimeoutMs) });
  if (!response.ok) throw new Error(`failed to download cover: ${response.status} ${response.statusText}`);
  const contentType = response.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().startsWith('image/')) throw new Error(`cover URL is not an image: ${contentType}`);
  await writeFile(file, await readLimited(response));
  return await normalizeCover(file);
}

async function normalizeCover(file: string) {
  const normalizedCoverFile = path.resolve(config.tempDir, 'covers', `${path.basename(file, path.extname(file))}-180x240.jpg`);
  await mkdir(path.dirname(normalizedCoverFile), { recursive: true });
  try {
    await execFileAsync('sips', ['-s', 'format', 'jpeg', '-z', '240', '180', file, '--out', normalizedCoverFile]);
    return normalizedCoverFile;
  } catch {
    // ponytail: no image library dependency; original file is used if macOS sips is unavailable.
    return file;
  }
}

function isVideoFile(file: string) {
  return ['.mp4', '.mov'].includes(path.extname(file).toLowerCase());
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function assertCoverSize(file: string) {
  const size = (await lstat(file)).size;
  if (size > maxCoverBytes) throw new Error(`cover file too large: ${file} (${size} bytes, max ${maxCoverBytes})`);
}

async function readLimited(response: Response) {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > maxCoverBytes) throw new Error(`cover file too large: ${length} bytes, max ${maxCoverBytes}`);
  if (!response.body) throw new Error('cover response has no body');

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const buffer = Buffer.from(value);
    total += buffer.length;
    if (total > maxCoverBytes) throw new Error(`cover file too large: ${total} bytes, max ${maxCoverBytes}`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function coverDownloadPath(taskId: string, url: URL) {
  const ext = imageExtensions.has(path.extname(url.pathname).toLowerCase())
    ? path.extname(url.pathname).toLowerCase()
    : '.jpg';
  return path.resolve(config.tempDir, 'covers', `${safeFileStem(taskId)}${ext}`);
}

function safeFileStem(value: string) {
  return safeFileName(value, { fallback: 'cover', maxLength: 80, replacement: '_' });
}
