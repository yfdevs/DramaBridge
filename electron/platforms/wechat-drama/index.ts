import { registerWechatRecreationHandlers } from "./netdisk";
import { staleTaskMonitor } from "../shared/stale-task-monitor"
import type { WechatPendingReport } from "@dramabridge/wechat-drama-automation"
import { app } from 'electron'
import { emitIpcEvent, trpcIpc as ipcMain } from '../../ipc'
import Store from 'electron-store'
import { createValidatedStore } from '../../core/config-store'
import { registerTaskAnalyticsHandler } from '../shared/task-analytics'
import cron, { type ScheduledTask } from 'node-cron'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  directoryDefaultPath,
  normalizePlatformRunDataDir,
  openExistingPath,
  playwrightBrowsersPath,
  resolveFromAppRoot,
  RuntimeController,
  selectDirectory,
} from '../shared'
import { cleanupBaiduNetdiskPlayletAfterTaskSuccess, ensureBaiduNetdiskShareDownloaded } from '../baidu-netdisk'
import { createElectronPlatformLogger } from '../../platform-logger'
import { registerRuntimeAssetCleanupRoot } from '../../runtime-asset-cleanup'
import {
  assertGlobalDirectoriesConfigured,
  createConfiguredAiClient,
  classifyConfiguredOwnershipLocally,
  resolveGlobalPlatformDirectories,
} from '../../global-app-config'

type WechatVideoRuntime = {
  getStatus: () => {
    videoAccounts: WechatVideoAccountStatus[]
  }
  focusVideoAccount?: (videoAccountId: string) => Promise<void>
  stop: () => Promise<void>
}

export type WechatVideoAccountStatus = {
  videoAccountId: string
  videoAccountName: string
  contractSubject?: string
  contractSubjectLabel?: string
  launched: boolean
  loginState: 'not-launched' | 'login-required' | 'logged-in' | 'unknown'
  pageCount: number
  activeUrl?: string
  userDataDir: string
}

export type WechatVideoServiceStatus = {
  running: boolean
  pid: number | null
  contractSubjects: Array<{ label: string; value: string }>
  videoAccounts: WechatVideoAccountStatus[]
}

export type WechatVideoConfig = {
  apiBaseUrl: string
  selectedVideoAccountIds: string
  videoAccountContractSubjects: string
  localEpisodeVideoRoot: string
  closeFailedTaskPages: string
  runDataDir: string
  logRetentionDays: string
  workerEmptyClaimDelaySeconds: string
  workerSlowEmptyClaimThreshold: string
  workerSlowEmptyClaimDelaySeconds: string
  videoAccountSyncIntervalSeconds: string
  idlePageRefreshIntervalSeconds: string
  idlePageRefreshTimeoutSeconds: string
  idlePageRefreshJitterSeconds: string
  basicInfoStepTimeoutSeconds: string
  remoteFileDownloadTimeoutSeconds: string
  baiduNetdiskDownloadRetryAttempts: string
  jianyingOwnershipProofCount: string
  juchuangOwnershipProofCount: string
  materialPreparationConcurrency: string
  taskPrefetchPerAccount: string
  videoTranscodeConcurrency: string
  videoTranscodeThreadsPerJob: string
  imageCompressionThresholdMegabytes: string
  imageCompressionTargetMegabytes: string
  episodeVideoMaxFileMegabytes: string
  episodeVideoTargetFileMegabytes: string
  episodeUploadWaitTimeoutSeconds: string
  episodeUploadFailedRetryAttempts: string
}

type WechatVideoConfigResult = {
  config: WechatVideoConfig
  path: string
  restartRequired: boolean
}

type WechatVideoStore = {
  pendingTaskReports?: WechatPendingReport[]
  config: Partial<WechatVideoConfig> & Record<string, string | undefined>
}

const defaultWechatVideoConfig: WechatVideoConfig = {
  apiBaseUrl: 'http://180.184.76.232:19090',
  selectedVideoAccountIds: '',
  videoAccountContractSubjects: 'MINGXINGSHUO,MISU,WEITAO,HUANZOU,XIAOSHILIU,YOUDIANNIU,ZHENCUIYIHAO,RUIXIAODOU,YUANMAN,YUNQIMANYING,MENGDONG,CHONGBAO,DOURAN',
  localEpisodeVideoRoot: '',
  closeFailedTaskPages: 'false',
  runDataDir: '.drama-runs/wechat-drama',
  logRetentionDays: '3',
  workerEmptyClaimDelaySeconds: '5',
  workerSlowEmptyClaimThreshold: '30',
  workerSlowEmptyClaimDelaySeconds: '30',
  videoAccountSyncIntervalSeconds: '600',
  idlePageRefreshIntervalSeconds: '10800',
  idlePageRefreshTimeoutSeconds: '60',
  idlePageRefreshJitterSeconds: '300',
  basicInfoStepTimeoutSeconds: '600',
  remoteFileDownloadTimeoutSeconds: '120',
  baiduNetdiskDownloadRetryAttempts: '3',
  jianyingOwnershipProofCount: '4',
  juchuangOwnershipProofCount: '4',
  materialPreparationConcurrency: '3',
  taskPrefetchPerAccount: '2',
  videoTranscodeConcurrency: '2',
  videoTranscodeThreadsPerJob: '2',
  imageCompressionThresholdMegabytes: '10',
  imageCompressionTargetMegabytes: '9',
  episodeVideoMaxFileMegabytes: '490',
  episodeVideoTargetFileMegabytes: '480',
  episodeUploadWaitTimeoutSeconds: '7200',
  episodeUploadFailedRetryAttempts: '3',
}

const contractSubjectOptions = [
  { label: '明星说', value: 'MINGXINGSHUO' },
  { label: '米苏', value: 'MISU' },
  { label: '微淘', value: 'WEITAO' },
  { label: '幻走', value: 'HUANZOU' },
  { label: '小石榴', value: 'XIAOSHILIU' },
  { label: '有点牛', value: 'YOUDIANNIU' },
  { label: '珍萃一号', value: 'ZHENCUIYIHAO' },
  { label: '瑞小豆', value: 'RUIXIAODOU' },
  { label: '广州元漫科技有限公司', value: 'YUANMAN' },
  { label: '北京云起漫影科技有限公司', value: 'YUNQIMANYING' },
  { label: '广州梦动科技有限公司', value: 'MENGDONG' },
  { label: '广州冲宝科技有限公司', value: 'CHONGBAO' },
  { label: '广州豆燃科技有限公司', value: 'DOURAN' },
]

const contractSubjectAliases: Record<string, string> = {
  明星说: 'MINGXINGSHUO',
  米苏: 'MISU',
  微淘: 'WEITAO',
  幻走: 'HUANZOU',
  小石榴: 'XIAOSHILIU',
  有点牛: 'YOUDIANNIU',
  珍萃: 'ZHENCUIYIHAO',
  珍萃一号: 'ZHENCUIYIHAO',
  瑞小豆: 'RUIXIAODOU',
  广州元漫科技有限公司: 'YUANMAN',
  北京云起漫影科技有限公司: 'YUNQIMANYING',
  广州梦动科技有限公司: 'MENGDONG',
  广州冲宝科技有限公司: 'CHONGBAO',
  广州豆燃科技有限公司: 'DOURAN',
}

const legacyDefaultContractSubjectSets = [
  new Set(['MINGXINGSHUO', 'MISU', 'WEITAO', 'HUANZOU', 'XIAOSHILIU']),
  new Set(['MINGXINGSHUO', 'MISU', 'WEITAO', 'HUANZOU', 'XIAOSHILIU', 'YOUDIANNIU']),
]

const invalidLogFileSegmentChars = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

const runtimeController = new RuntimeController<WechatVideoRuntime>()
let store: Store<WechatVideoStore> | null = null
let contractCleanupTask: ScheduledTask | null = null

export function getWechatVideoBrowserInstanceCount() {
  return runtimeController.current
    ?.getStatus()
    .videoAccounts.filter((account) => account.launched).length ?? 0
}

export function getWechatVideoRunningPlatformCount() {
  return runtimeController.running ? 1 : 0
}

export function getWechatVideoPlatformRuntimeSummary() {
  const currentStatus = runtimeController.current?.getStatus()
  const browserInstances = currentStatus?.videoAccounts
    .filter((account) => account.launched)
    .map((account) => ({
      id: account.videoAccountId,
      label: account.videoAccountName || account.videoAccountId,
      loginState: account.loginState,
      activeUrl: account.activeUrl,
    })) ?? []

  return {
    platform: 'wechat-drama' as const,
    running: runtimeController.running,
    startedAt: runtimeController.startedAt,
    browserInstanceCount: browserInstances.length,
    browserInstances,
    logDir: logDirPath(),
  }
}

export function openWechatVideoLogDir() {
  const logsDir = logDirPath()
  mkdirSync(logsDir, { recursive: true })
  return openExistingPath(logsDir)
}

function readSelectedContractSubjects(config = readConfig()) {
  const selectedSubjects = new Set(
    config.videoAccountContractSubjects
      .split(',')
      .map((subject) => subject.trim())
      .filter(Boolean),
  )

  return contractSubjectOptions.filter((option) => selectedSubjects.has(option.value))
}

function formatContractSubjectLabel(value: string | undefined) {
  if (!value) return undefined
  const trimmedValue = value.trim()
  const normalizedValue = contractSubjectAliases[trimmedValue] ?? trimmedValue.toUpperCase()
  return contractSubjectOptions.find((option) => option.value === normalizedValue)?.label ?? value
}

async function status(): Promise<WechatVideoServiceStatus> {
  const runtime = runtimeController.current

  return {
    running: runtimeController.running,
    pid: runtime ? process.pid : null,
    contractSubjects: readSelectedContractSubjects(),
    videoAccounts: runtime?.getStatus().videoAccounts.map((account) => ({
      ...account,
      contractSubjectLabel: formatContractSubjectLabel(account.contractSubject),
    })) ?? [],
  }
}

function getStore() {
  if (!store) {
    store = createValidatedStore<WechatVideoStore>({
      name: 'wechat-drama-config',
      defaults: {
        config: defaultWechatVideoConfig,
      },
    })
  }

  return store
}

function configPath() {
  return getStore().path
}

function readConfig(): WechatVideoConfig {
  const config = normalizeConfig(getStore().get('config'))
  const directories = resolveGlobalPlatformDirectories('wechat-drama', {
    runDataDir: config.runDataDir,
    localMaterialRoot: config.localEpisodeVideoRoot,
  })
  return {
    ...config,
    runDataDir: directories.runDataDir,
    localEpisodeVideoRoot: directories.localMaterialRoot,
  }
}

function writeConfig(config: WechatVideoConfig) {
  getStore().set('config', config)
}

function broadcastConfigChanged(result: WechatVideoConfigResult) {
  emitIpcEvent('wechat-drama:config:changed', result)
}

function normalizeConfig(
  config: Partial<WechatVideoConfig> & Record<string, string | undefined>,
): WechatVideoConfig {
  const selectedContractSubjects = new Set(
    (config.videoAccountContractSubjects ?? defaultWechatVideoConfig.videoAccountContractSubjects)
      .split(',')
      .map((subject) => subject.trim())
      .filter(Boolean),
  )
  const usesLegacyDefaultContractSubjects = legacyDefaultContractSubjectSets.some((legacySubjects) => (
    selectedContractSubjects.size === legacySubjects.size
    && [...legacySubjects].every((subject) => selectedContractSubjects.has(subject))
  ))
  if (usesLegacyDefaultContractSubjects) {
    selectedContractSubjects.add('YOUDIANNIU')
    selectedContractSubjects.add('ZHENCUIYIHAO')
    selectedContractSubjects.add('RUIXIAODOU')
  }

  return {
    apiBaseUrl: config.apiBaseUrl ?? defaultWechatVideoConfig.apiBaseUrl,
    selectedVideoAccountIds: config.selectedVideoAccountIds ?? '',
    videoAccountContractSubjects: contractSubjectOptions
      .map((option) => option.value)
      .filter((subject) => selectedContractSubjects.has(subject))
      .join(','),
    localEpisodeVideoRoot: config.localEpisodeVideoRoot ?? defaultWechatVideoConfig.localEpisodeVideoRoot,
    closeFailedTaskPages: config.closeFailedTaskPages ?? defaultWechatVideoConfig.closeFailedTaskPages,
    runDataDir:
      !config.runDataDir || config.runDataDir === '.drama-runs'
        ? defaultWechatVideoConfig.runDataDir
        : config.runDataDir,
    logRetentionDays: config.logRetentionDays ?? defaultWechatVideoConfig.logRetentionDays,
    workerEmptyClaimDelaySeconds: config.workerEmptyClaimDelaySeconds ?? defaultWechatVideoConfig.workerEmptyClaimDelaySeconds,
    workerSlowEmptyClaimThreshold: config.workerSlowEmptyClaimThreshold ?? defaultWechatVideoConfig.workerSlowEmptyClaimThreshold,
    workerSlowEmptyClaimDelaySeconds: config.workerSlowEmptyClaimDelaySeconds ?? defaultWechatVideoConfig.workerSlowEmptyClaimDelaySeconds,
    videoAccountSyncIntervalSeconds: config.videoAccountSyncIntervalSeconds ?? defaultWechatVideoConfig.videoAccountSyncIntervalSeconds,
    idlePageRefreshIntervalSeconds: config.idlePageRefreshIntervalSeconds ?? defaultWechatVideoConfig.idlePageRefreshIntervalSeconds,
    idlePageRefreshTimeoutSeconds: config.idlePageRefreshTimeoutSeconds ?? defaultWechatVideoConfig.idlePageRefreshTimeoutSeconds,
    idlePageRefreshJitterSeconds: config.idlePageRefreshJitterSeconds ?? defaultWechatVideoConfig.idlePageRefreshJitterSeconds,
    basicInfoStepTimeoutSeconds: config.basicInfoStepTimeoutSeconds ?? defaultWechatVideoConfig.basicInfoStepTimeoutSeconds,
    remoteFileDownloadTimeoutSeconds: config.remoteFileDownloadTimeoutSeconds ?? defaultWechatVideoConfig.remoteFileDownloadTimeoutSeconds,
    baiduNetdiskDownloadRetryAttempts: config.baiduNetdiskDownloadRetryAttempts ?? defaultWechatVideoConfig.baiduNetdiskDownloadRetryAttempts,
    jianyingOwnershipProofCount: normalizeOwnershipProofCount(config.jianyingOwnershipProofCount),
    juchuangOwnershipProofCount: normalizeOwnershipProofCount(config.juchuangOwnershipProofCount),
    materialPreparationConcurrency: config.materialPreparationConcurrency ?? defaultWechatVideoConfig.materialPreparationConcurrency,
    taskPrefetchPerAccount: config.taskPrefetchPerAccount ?? defaultWechatVideoConfig.taskPrefetchPerAccount,
    videoTranscodeConcurrency: config.videoTranscodeConcurrency ?? defaultWechatVideoConfig.videoTranscodeConcurrency,
    videoTranscodeThreadsPerJob: config.videoTranscodeThreadsPerJob ?? defaultWechatVideoConfig.videoTranscodeThreadsPerJob,
    imageCompressionThresholdMegabytes: config.imageCompressionThresholdMegabytes ?? defaultWechatVideoConfig.imageCompressionThresholdMegabytes,
    imageCompressionTargetMegabytes: config.imageCompressionTargetMegabytes ?? defaultWechatVideoConfig.imageCompressionTargetMegabytes,
    episodeVideoMaxFileMegabytes:
      !config.episodeVideoMaxFileMegabytes || config.episodeVideoMaxFileMegabytes === '500'
        ? defaultWechatVideoConfig.episodeVideoMaxFileMegabytes
        : config.episodeVideoMaxFileMegabytes,
    episodeVideoTargetFileMegabytes: config.episodeVideoTargetFileMegabytes ?? defaultWechatVideoConfig.episodeVideoTargetFileMegabytes,
    episodeUploadWaitTimeoutSeconds: config.episodeUploadWaitTimeoutSeconds ?? defaultWechatVideoConfig.episodeUploadWaitTimeoutSeconds,
    episodeUploadFailedRetryAttempts: config.episodeUploadFailedRetryAttempts ?? defaultWechatVideoConfig.episodeUploadFailedRetryAttempts,
  }
}

function normalizeOwnershipProofCount(value: string | undefined) {
  const count = Number(value)
  return Number.isSafeInteger(count) && count > 0 ? String(count) : '4'
}

function assertOwnershipProofCounts(config: WechatVideoConfig) {
  if (
    normalizeOwnershipProofCount(config.jianyingOwnershipProofCount) !== config.jianyingOwnershipProofCount
    || normalizeOwnershipProofCount(config.juchuangOwnershipProofCount) !== config.juchuangOwnershipProofCount
  ) {
    throw new Error('剪映和剧创权属图片数量必须分别填写正整数。')
  }
}

function sanitizeLogFileSegment(value: string) {
  const sanitized = Array.from(value.trim(), (char) => (
    invalidLogFileSegmentChars.has(char) || char.charCodeAt(0) <= 0x1f ? '_' : char
  )).join('')
  return sanitized || 'unknown'
}

function logDirPath(config = readConfig()) {
  return path.join(resolveFromAppRoot(config.runDataDir), 'logs')
}

function registerWechatRuntimeAssetCleanup(config = readConfig()) {
  registerRuntimeAssetCleanupRoot({
    platform: 'wechat-drama',
    rootPath: resolveFromAppRoot(config.runDataDir),
    maxDepth: 1,
    retentionMs: 3 * 60 * 60 * 1000,
  })
}

function wechatPlatformLogger(scope = 'runtime') {
  const config = readConfig()
  return createElectronPlatformLogger({
    platform: 'wechat-drama',
    scope,
    logDir: logDirPath(config),
    retentionDays: Number.parseInt(config.logRetentionDays, 10) || 3,
  })
}

function isMissingContractPathError(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function latestContractModifiedAtMs(target: string): Promise<number> {
  const targetStat = await lstat(target)
  let latest = targetStat.mtimeMs
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return latest

  const entries = await readdir(target, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    latest = Math.max(latest, await latestContractModifiedAtMs(path.join(target, entry.name)))
  }
  return latest
}

async function cleanupPreviousWechatCopyrightProofs(now = new Date()) {
  const proofParent = path.resolve(resolveFromAppRoot(readConfig().runDataDir), 'remote-upload-assets')
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  let entries
  try {
    entries = await readdir(proofParent, { withFileTypes: true })
  } catch (error) {
    if (isMissingContractPathError(error)) return
    throw error
  }

  let deletedCount = 0
  for (const entry of entries) {
    if (
      !entry.isDirectory()
      || entry.isSymbolicLink()
      || !entry.name.toLowerCase().endsWith('-contract')
    ) {
      continue
    }
    const contractDir = path.resolve(proofParent, entry.name)
    const relativeContractDir = path.relative(proofParent, contractDir)
    if (
      !relativeContractDir
      || relativeContractDir.startsWith('..')
      || path.isAbsolute(relativeContractDir)
    ) {
      continue
    }
    const modifiedAtMs = await latestContractModifiedAtMs(contractDir).catch((error: unknown) => {
      if (isMissingContractPathError(error)) return startOfToday
      throw error
    })
    if (modifiedAtMs >= startOfToday) continue

    await rm(contractDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    deletedCount += 1
    wechatPlatformLogger('storage').info('Deleted expired copyright materials', { path: contractDir })
  }
  wechatPlatformLogger('storage').info('Expired copyright materials cleanup completed', { deletedCount })
}

function scheduleWechatCopyrightProofCleanup() {
  if (contractCleanupTask) return
  contractCleanupTask = cron.schedule('0 1 * * *', async () => {
    await cleanupPreviousWechatCopyrightProofs().catch((error: unknown) => {
      wechatPlatformLogger('storage').error('Expired copyright materials cleanup failed', { error })
    })
  }, {
    name: 'wechat-copyright-proof-cleanup',
    timezone: 'Asia/Shanghai',
    noOverlap: true,
    unref: true,
  })
  wechatPlatformLogger('storage').info('Copyright materials scheduled cleanup enabled', {
    schedule: 'daily at 01:00',
  })
}

function findLatestVideoAccountLogFile(videoAccountId: string) {
  const logsDir = logDirPath()
  mkdirSync(logsDir, { recursive: true })

  const accountIdSegment = sanitizeLogFileSegment(videoAccountId)
  const legacyAccountLogPrefix = `app-${accountIdSegment}-`
  const accountLogSegment = `-${accountIdSegment}-`
  const latestLogFile = readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => (
      entry.isFile()
      && /\.(jsonl|log)$/i.test(entry.name)
      && (
        entry.name.startsWith(legacyAccountLogPrefix)
        || entry.name.includes(accountLogSegment)
      )
    ))
    .map((entry) => path.join(logsDir, entry.name))
    .sort((left, right) => {
      const leftMtime = statSync(left).mtimeMs
      const rightMtime = statSync(right).mtimeMs
      return rightMtime - leftMtime
    })[0]

  if (latestLogFile) return latestLogFile

  const latestPlatformLog = readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^app-\d{4}-\d{2}-\d{2}\.(?:json|log)$/i.test(entry.name))
    .map((entry) => path.join(logsDir, entry.name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]

  return latestPlatformLog ?? logsDir
}

function assertWechatVideoConfigReady(config = readConfig()) {
  if (!config.localEpisodeVideoRoot.trim()) {
    throw new Error('WECHAT_LOCAL_VIDEO_ROOT_REQUIRED')
  }
  const maxVideoMegabytes = Number(config.episodeVideoMaxFileMegabytes)
  const targetVideoMegabytes = Number(config.episodeVideoTargetFileMegabytes)
  if (
    !Number.isFinite(maxVideoMegabytes)
    || !Number.isFinite(targetVideoMegabytes)
    || maxVideoMegabytes <= 0
    || targetVideoMegabytes <= 0
    || targetVideoMegabytes >= maxVideoMegabytes
  ) {
    throw new Error('视频压缩目标体积必须大于 0 且小于单集视频上限。')
  }
  const imageThresholdMegabytes = Number(config.imageCompressionThresholdMegabytes)
  const imageTargetMegabytes = Number(config.imageCompressionTargetMegabytes)
  if (
    !Number.isFinite(imageThresholdMegabytes)
    || !Number.isFinite(imageTargetMegabytes)
    || imageThresholdMegabytes <= 0
    || imageTargetMegabytes <= 0
    || imageTargetMegabytes >= imageThresholdMegabytes
  ) {
    throw new Error('图片压缩目标体积必须大于 0 且小于压缩触发体积。')
  }
}

async function listSelectableWechatAccounts() {
  const config = readConfig();
  const accounts: Array<{ id: string; name: string; status: string }> = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, '')}/dramaAiRpa/videoAccountConfig/page`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page, pageSize: 100 }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`视频号账号查询失败：HTTP ${response.status}`);
    const result = await response.json() as { code: number; msg?: string; data?: { total?: number; data?: Array<{ videoAccountId: string; videoAccountName: string; status: string }> } };
    if (result.code !== 0 || !Array.isArray(result.data?.data)) throw new Error(result.msg || '视频号账号查询失败');
    accounts.push(...result.data.data.map(item => ({ id: item.videoAccountId, name: item.videoAccountName, status: item.status })));
    if (result.data.data.length < 100 || accounts.length >= (result.data.total ?? Infinity)) break;
  }
  return { accounts, selectedAccountIds: config.selectedVideoAccountIds.split(',').filter(Boolean) };
}

async function startRuntime() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath()

  const { startWechatVideoRuntime } = await import('@dramabridge/wechat-drama-automation')
  return startWechatVideoRuntime({
    settings: readConfig(),
    taskWatchdog: staleTaskMonitor("wechat-drama", { apiBaseUrl: () => readConfig().apiBaseUrl }),
    reportStore: {
      load: () => getStore().get('pendingTaskReports') ?? [],
      save: (reports) => getStore().set('pendingTaskReports', reports),
    },
    ownershipAiClient: createConfiguredAiClient(),
    classifyOwnershipLocally: classifyConfiguredOwnershipLocally,
    ensureBaiduNetdiskResource: (request) => ensureBaiduNetdiskShareDownloaded({
      ...request,
      requesterPlatform: "wechat-drama",
    }),
    cleanupBaiduNetdiskResourceAfterTaskSuccess: cleanupBaiduNetdiskPlayletAfterTaskSuccess,
  })
}

export function registerWechatVideoPlatformHandlers() {
  registerWechatRecreationHandlers();
  ipcMain.handle("wechat-drama:tasks:cleanup", () => staleTaskMonitor("wechat-drama", { apiBaseUrl: () => readConfig().apiBaseUrl }).sweep());
  staleTaskMonitor("wechat-drama", { apiBaseUrl: () => readConfig().apiBaseUrl });
  registerTaskAnalyticsHandler({
    platform: 'wechat-drama',
    apiBaseUrl: () => readConfig().apiBaseUrl,
    apiPrefix: '/dramaAiRpa',
    accountConfigPath: '/dramaAiRpa/videoAccountConfig/page',
    accountIdField: 'videoAccountId',
    statusField: 'rpaStatus',
  })
  registerWechatRuntimeAssetCleanup()
  scheduleWechatCopyrightProofCleanup()

  ipcMain.handle('wechat-drama:config:get', () => ({
    config: readConfig(),
    path: configPath(),
    restartRequired: false,
  }))

  ipcMain.handle('wechat-drama:config:save', async (_event, config: WechatVideoConfig) => {
    assertOwnershipProofCounts(config)
    const nextConfig = normalizeConfig({ ...config, selectedVideoAccountIds: readConfig().selectedVideoAccountIds })
    writeConfig(nextConfig)
    registerWechatRuntimeAssetCleanup(readConfig())
    const result = {
      config: nextConfig,
      path: configPath(),
      restartRequired: runtimeController.running || runtimeController.startingPromise !== null,
    }
    broadcastConfigChanged(result)
    return result
  })

  ipcMain.handle('wechat-drama:config:select-local-episode-video-root', async (event, currentPath?: string) => {
    return selectDirectory(event, {
      title: '选择剧集视频根目录',
      defaultPath: directoryDefaultPath(currentPath, app.getPath('videos')),
      properties: ['openDirectory', 'createDirectory'],
    })
  })

  ipcMain.handle('wechat-drama:config:select-run-data-dir', async (event, currentPath?: string) => {
    const selectedPath = await selectDirectory(event, {
      title: '选择运行数据目录',
      defaultPath: directoryDefaultPath(currentPath, app.getPath('documents')),
      properties: ['openDirectory', 'createDirectory'],
    })

    return normalizePlatformRunDataDir(selectedPath, 'wechat-drama')
  })

  ipcMain.handle('wechat-drama:service:status', () => status())

  ipcMain.handle('wechat-drama:accounts:list', () => listSelectableWechatAccounts())
  ipcMain.handle('wechat-drama:accounts:select', async (_event, ids: string[]) => {
    if (runtimeController.running || runtimeController.startingPromise) throw new Error('请先停止服务再调整账号')
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('账号选择无效')
    const { accounts } = await listSelectableWechatAccounts()
    const available = new Set(accounts.filter(account => account.status === 'ON').map(account => account.id))
    if (ids.some(id => !available.has(id))) throw new Error('所选账号已停用或不存在，请刷新列表')
    const config = normalizeConfig({ ...readConfig(), selectedVideoAccountIds: [...new Set(ids)].join(',') })
    getStore().set('config', config)
    return { selectedAccountIds: ids }
  })

  ipcMain.handle('wechat-drama:service:start', async () => {
    assertGlobalDirectoriesConfigured()
    assertWechatVideoConfigReady()
    await runtimeController.start(startRuntime)
    return status()
  })

  ipcMain.handle('wechat-drama:service:stop', async () => {
    await runtimeController.stop()
    return status()
  })

  ipcMain.handle('wechat-drama:service:video-account:focus', async (_event, videoAccountId: string) => {
    const runtime = await runtimeController.resolveStarting()

    if (!runtime) {
      throw new Error('微信视频号服务未启动。')
    }

    let currentRuntime = runtime
    if (typeof currentRuntime.focusVideoAccount !== 'function') {
      currentRuntime = await runtimeController.replace(startRuntime)
    }

    if (typeof currentRuntime.focusVideoAccount !== 'function') {
      throw new Error('当前微信视频号服务实例不支持打开浏览器到前台，请重启应用后再试。')
    }

    await currentRuntime.focusVideoAccount(videoAccountId)
    return status()
  })

  ipcMain.handle('wechat-drama:service:video-account:open-log', async (_event, videoAccountId: string) => {
    return openExistingPath(findLatestVideoAccountLogFile(videoAccountId))
  })
}

export function stopWechatVideoPlatformRuntime() {
  runtimeController.stopInBackground()
}

export function stopWechatVideoPlatformService() {
  return runtimeController.stop()
}
