import { app, BrowserWindow, ipcMain } from 'electron'
import Store from 'electron-store'
import { registerTaskAnalyticsHandler } from './task-analytics'
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
} from './shared'
import { cleanupBaiduNetdiskPlayletAfterTaskSuccess, ensureBaiduNetdiskShareDownloaded } from './baidu-netdisk'
import { createElectronPlatformLogger } from '../platform-logger'
import { registerRuntimeAssetCleanupRoot } from '../runtime-asset-cleanup'
import {
  assertGlobalDirectoriesConfigured,
  resolveGlobalPlatformDirectories,
} from '../global-app-config'
import { WechatMiniProgramDirectUploadCoordinator } from './wechat-miniprogram-drama/direct-upload'
import { WechatMiniProgramCatalogUploadCoordinator } from './wechat-miniprogram-drama/catalog-upload'

type WechatMiniProgramRuntime = {
  getStatus: () => {
    videoAccounts: WechatMiniProgramAccountStatus[]
  }
  focusVideoAccount?: (videoAccountId: string) => Promise<void>
  stop: () => Promise<void>
}

export type WechatMiniProgramAccountStatus = {
  videoAccountId: string
  videoAccountName: string
  launched: boolean
  loginState: 'not-launched' | 'login-required' | 'logged-in' | 'unknown'
  pageCount: number
  activeUrl?: string
  userDataDir: string
}

export type WechatMiniProgramServiceStatus = {
  running: boolean
  pid: number | null
  videoAccounts: WechatMiniProgramAccountStatus[]
}

export type WechatMiniProgramConfig = {
  apiBaseUrl: string
  taskApiPrefix: string
  catalogApiBaseUrl: string
  localEpisodeVideoRoot: string
  closeFailedTaskPages: string
  runDataDir: string
  logRetentionDays: string
  workerEmptyClaimDelaySeconds: string
  workerSlowEmptyClaimThreshold: string
  workerSlowEmptyClaimDelaySeconds: string
  videoAccountSyncIntervalSeconds: string
  catalogAutoSyncIntervalSeconds: string
  idlePageRefreshIntervalSeconds: string
  idlePageRefreshTimeoutSeconds: string
  idlePageRefreshJitterSeconds: string
  basicInfoStepTimeoutSeconds: string
  remoteFileDownloadTimeoutSeconds: string
  baiduNetdiskDownloadRetryAttempts: string
  mergeOwnershipMaterials: string
  materialPreparationConcurrency: string
  taskPrefetchPerAccount: string
  videoTranscodeConcurrency: string
  videoTranscodeThreadsPerJob: string
  episodeVideoMaxFileMegabytes: string
  episodeVideoTargetFileMegabytes: string
  episodeVideoMinimumDurationSeconds: string
  episodeUploadWaitTimeoutSeconds: string
  episodeUploadFailedRetryAttempts: string
  feishuBotWebhookUrl: string
}

type WechatMiniProgramConfigResult = {
  config: WechatMiniProgramConfig
  path: string
  restartRequired: boolean
}

type WechatMiniProgramStore = {
  config: Partial<WechatMiniProgramConfig> & Record<string, string | undefined>
}

const defaultWechatMiniProgramConfig: WechatMiniProgramConfig = {
  apiBaseUrl: 'http://180.184.76.232:19090',
  taskApiPrefix: '/dramaAiRpa/wechatMiniProgram',
  catalogApiBaseUrl: 'https://wxmini.xiaoshuo666.cn:8006',
  localEpisodeVideoRoot: '',
  closeFailedTaskPages: 'false',
  runDataDir: '.drama-runs/wechat-miniprogram-drama',
  logRetentionDays: '3',
  workerEmptyClaimDelaySeconds: '5',
  workerSlowEmptyClaimThreshold: '30',
  workerSlowEmptyClaimDelaySeconds: '30',
  videoAccountSyncIntervalSeconds: '600',
  catalogAutoSyncIntervalSeconds: '15',
  idlePageRefreshIntervalSeconds: '10800',
  idlePageRefreshTimeoutSeconds: '60',
  idlePageRefreshJitterSeconds: '300',
  basicInfoStepTimeoutSeconds: '600',
  remoteFileDownloadTimeoutSeconds: '120',
  baiduNetdiskDownloadRetryAttempts: '3',
  mergeOwnershipMaterials: 'true',
  materialPreparationConcurrency: '3',
  taskPrefetchPerAccount: '2',
  videoTranscodeConcurrency: '2',
  videoTranscodeThreadsPerJob: '2',
  episodeVideoMaxFileMegabytes: '490',
  episodeVideoTargetFileMegabytes: '480',
  episodeVideoMinimumDurationSeconds: '0',
  episodeUploadWaitTimeoutSeconds: '7200',
  episodeUploadFailedRetryAttempts: '5',
  feishuBotWebhookUrl: '',
}

const invalidLogFileSegmentChars = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

const runtimeController = new RuntimeController<WechatMiniProgramRuntime>()
const directUploadBrowserId = 'baidu-direct-upload'
const directUploadCoordinator = new WechatMiniProgramDirectUploadCoordinator({
  getSettings: () => readConfig(),
  regularServiceRunning: () => runtimeController.running || runtimeController.startingPromise !== null,
  playwrightBrowsersPath,
})
const catalogUploadCoordinator = new WechatMiniProgramCatalogUploadCoordinator({
  getSettings: () => readConfig(),
})
let store: Store<WechatMiniProgramStore> | null = null
let contractCleanupTask: ScheduledTask | null = null

export function getWechatMiniProgramBrowserInstanceCount() {
  const regularBrowserCount = runtimeController.current
    ?.getStatus()
    .videoAccounts.filter((account) => account.launched).length ?? 0
  return regularBrowserCount + directUploadCoordinator.getBrowserInstanceCount()
}

export function getWechatMiniProgramRunningPlatformCount() {
  return runtimeController.running || directUploadCoordinator.isActive() || catalogUploadCoordinator.isActive() ? 1 : 0
}

export function getWechatMiniProgramPlatformRuntimeSummary() {
  const currentStatus = runtimeController.current?.getStatus()
  const browserInstances = currentStatus?.videoAccounts
    .filter((account) => account.launched)
    .map((account) => ({
      id: account.videoAccountId,
      label: account.videoAccountName || account.videoAccountId,
      loginState: account.loginState,
      activeUrl: account.activeUrl,
    })) ?? []
  const directBrowser = directUploadCoordinator.workspace().browser
  if (directBrowser.launched) {
    browserInstances.push({
      id: directUploadBrowserId,
      label: '百度资源直传',
      loginState: directBrowser.loginState,
      activeUrl: directBrowser.activeUrl,
    })
  }

  return {
    platform: 'wechat-miniprogram-drama' as const,
    running: runtimeController.running || catalogUploadCoordinator.isActive(),
    startedAt: runtimeController.startedAt,
    browserInstanceCount: browserInstances.length,
    browserInstances,
    logDir: logDirPath(),
  }
}

export function openWechatMiniProgramLogDir() {
  const logsDir = logDirPath()
  mkdirSync(logsDir, { recursive: true })
  return openExistingPath(logsDir)
}

async function status(): Promise<WechatMiniProgramServiceStatus> {
  const runtime = runtimeController.current

  return {
    running: runtimeController.running,
    pid: runtime ? process.pid : null,
    videoAccounts: runtime?.getStatus().videoAccounts ?? [],
  }
}

function getStore() {
  if (!store) {
    store = new Store<WechatMiniProgramStore>({
      name: 'wechat-miniprogram-drama-config',
      defaults: {
        config: defaultWechatMiniProgramConfig,
      },
    })
  }

  return store
}

function configPath() {
  return getStore().path
}

function readConfig(): WechatMiniProgramConfig {
  const config = normalizeConfig(getStore().get('config'))
  const directories = resolveGlobalPlatformDirectories('wechat-miniprogram-drama', {
    runDataDir: config.runDataDir,
    localMaterialRoot: config.localEpisodeVideoRoot,
  })
  return {
    ...config,
    runDataDir: directories.runDataDir,
    localEpisodeVideoRoot: directories.localMaterialRoot,
  }
}

function writeConfig(config: WechatMiniProgramConfig) {
  getStore().set('config', config)
}

function broadcastConfigChanged(result: WechatMiniProgramConfigResult) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('wechat-miniprogram-drama:config:changed', result)
  }
}

function normalizeConfig(
  config: Partial<WechatMiniProgramConfig> & Record<string, string | undefined>,
): WechatMiniProgramConfig {
  const configuredMinimumDuration = config.episodeVideoMinimumDurationSeconds?.trim()
  const normalizedMinimumDuration = configuredMinimumDuration !== undefined
    && configuredMinimumDuration !== ''
    && Number.isFinite(Number(configuredMinimumDuration))
    && Number(configuredMinimumDuration) >= 0
    ? configuredMinimumDuration
    : defaultWechatMiniProgramConfig.episodeVideoMinimumDurationSeconds

  return {
    apiBaseUrl: config.apiBaseUrl ?? defaultWechatMiniProgramConfig.apiBaseUrl,
    taskApiPrefix: config.taskApiPrefix?.trim() || defaultWechatMiniProgramConfig.taskApiPrefix,
    catalogApiBaseUrl:
      config.catalogApiBaseUrl?.trim()
      || config.materialUploadApiBaseUrl?.trim()
      || defaultWechatMiniProgramConfig.catalogApiBaseUrl,
    localEpisodeVideoRoot: config.localEpisodeVideoRoot ?? defaultWechatMiniProgramConfig.localEpisodeVideoRoot,
    closeFailedTaskPages: config.closeFailedTaskPages ?? defaultWechatMiniProgramConfig.closeFailedTaskPages,
    runDataDir:
      !config.runDataDir || config.runDataDir === '.drama-runs'
        ? defaultWechatMiniProgramConfig.runDataDir
        : config.runDataDir,
    logRetentionDays: config.logRetentionDays ?? defaultWechatMiniProgramConfig.logRetentionDays,
    workerEmptyClaimDelaySeconds: config.workerEmptyClaimDelaySeconds ?? defaultWechatMiniProgramConfig.workerEmptyClaimDelaySeconds,
    workerSlowEmptyClaimThreshold: config.workerSlowEmptyClaimThreshold ?? defaultWechatMiniProgramConfig.workerSlowEmptyClaimThreshold,
    workerSlowEmptyClaimDelaySeconds: config.workerSlowEmptyClaimDelaySeconds ?? defaultWechatMiniProgramConfig.workerSlowEmptyClaimDelaySeconds,
    videoAccountSyncIntervalSeconds: config.videoAccountSyncIntervalSeconds ?? defaultWechatMiniProgramConfig.videoAccountSyncIntervalSeconds,
    catalogAutoSyncIntervalSeconds: config.catalogAutoSyncIntervalSeconds ?? defaultWechatMiniProgramConfig.catalogAutoSyncIntervalSeconds,
    idlePageRefreshIntervalSeconds: config.idlePageRefreshIntervalSeconds ?? defaultWechatMiniProgramConfig.idlePageRefreshIntervalSeconds,
    idlePageRefreshTimeoutSeconds: config.idlePageRefreshTimeoutSeconds ?? defaultWechatMiniProgramConfig.idlePageRefreshTimeoutSeconds,
    idlePageRefreshJitterSeconds: config.idlePageRefreshJitterSeconds ?? defaultWechatMiniProgramConfig.idlePageRefreshJitterSeconds,
    basicInfoStepTimeoutSeconds: config.basicInfoStepTimeoutSeconds ?? defaultWechatMiniProgramConfig.basicInfoStepTimeoutSeconds,
    remoteFileDownloadTimeoutSeconds: config.remoteFileDownloadTimeoutSeconds ?? defaultWechatMiniProgramConfig.remoteFileDownloadTimeoutSeconds,
    baiduNetdiskDownloadRetryAttempts: config.baiduNetdiskDownloadRetryAttempts ?? defaultWechatMiniProgramConfig.baiduNetdiskDownloadRetryAttempts,
    mergeOwnershipMaterials: config.mergeOwnershipMaterials ?? defaultWechatMiniProgramConfig.mergeOwnershipMaterials,
    materialPreparationConcurrency: config.materialPreparationConcurrency ?? defaultWechatMiniProgramConfig.materialPreparationConcurrency,
    taskPrefetchPerAccount: config.taskPrefetchPerAccount ?? defaultWechatMiniProgramConfig.taskPrefetchPerAccount,
    videoTranscodeConcurrency: config.videoTranscodeConcurrency ?? defaultWechatMiniProgramConfig.videoTranscodeConcurrency,
    videoTranscodeThreadsPerJob: config.videoTranscodeThreadsPerJob ?? defaultWechatMiniProgramConfig.videoTranscodeThreadsPerJob,
    episodeVideoMaxFileMegabytes:
      !config.episodeVideoMaxFileMegabytes || config.episodeVideoMaxFileMegabytes === '500'
        ? defaultWechatMiniProgramConfig.episodeVideoMaxFileMegabytes
        : config.episodeVideoMaxFileMegabytes,
    episodeVideoTargetFileMegabytes: config.episodeVideoTargetFileMegabytes ?? defaultWechatMiniProgramConfig.episodeVideoTargetFileMegabytes,
    episodeVideoMinimumDurationSeconds: normalizedMinimumDuration,
    episodeUploadWaitTimeoutSeconds: config.episodeUploadWaitTimeoutSeconds ?? defaultWechatMiniProgramConfig.episodeUploadWaitTimeoutSeconds,
    episodeUploadFailedRetryAttempts: config.episodeUploadFailedRetryAttempts ?? defaultWechatMiniProgramConfig.episodeUploadFailedRetryAttempts,
    feishuBotWebhookUrl: config.feishuBotWebhookUrl ?? defaultWechatMiniProgramConfig.feishuBotWebhookUrl,
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

function registerWechatMiniProgramRuntimeAssetCleanup(config = readConfig()) {
  registerRuntimeAssetCleanupRoot({
    platform: 'wechat-miniprogram-drama',
    rootPath: resolveFromAppRoot(config.runDataDir),
    maxDepth: 1,
    retentionMs: 3 * 60 * 60 * 1000,
  })
}

function wechatPlatformLogger(scope = 'runtime') {
  const config = readConfig()
  return createElectronPlatformLogger({
    platform: 'wechat-miniprogram-drama',
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
    name: 'wechat-miniprogram-copyright-proof-cleanup',
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
    .filter((entry) => entry.isFile() && /^app-\d{4}-\d{2}-\d{2}\.log$/i.test(entry.name))
    .map((entry) => path.join(logsDir, entry.name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]

  return latestPlatformLog ?? logsDir
}

function assertWechatMiniProgramConfigReady(config = readConfig()) {
  if (!config.localEpisodeVideoRoot.trim()) {
    throw new Error('WECHAT_MINIPROGRAM_LOCAL_VIDEO_ROOT_REQUIRED')
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
  const minimumDurationSeconds = Number(config.episodeVideoMinimumDurationSeconds)
  if (!Number.isFinite(minimumDurationSeconds) || minimumDurationSeconds < 0) {
    throw new Error('单集最小时长必须是大于或等于 0 的数字。')
  }
}

async function startRuntime() {
  process.env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath()

  const { startWechatMiniProgramRuntime } = await import('@dramabridge/wechat-miniprogram-drama-automation')
  return startWechatMiniProgramRuntime({
    settings: {
      ...readConfig(),
      mockAssetRoot: app.isPackaged
        ? path.join(app.getAppPath(), 'dist', 'wechat-miniprogram-drama', 'mock-assets')
        : resolveFromAppRoot('public/wechat-miniprogram-drama/mock-assets'),
    },
    ensureBaiduNetdiskResource: (request) => ensureBaiduNetdiskShareDownloaded({
      ...request,
      requesterPlatform: "wechat-miniprogram-drama",
    }),
    cleanupBaiduNetdiskResourceAfterTaskSuccess: cleanupBaiduNetdiskPlayletAfterTaskSuccess,
  })
}

export function registerWechatMiniProgramPlatformHandlers() {
  registerTaskAnalyticsHandler({
    platform: 'wechat-miniprogram-drama',
    apiBaseUrl: () => readConfig().apiBaseUrl,
    apiPrefix: '/dramaAiRpa/wechatMiniProgram',
  })
  registerWechatMiniProgramRuntimeAssetCleanup()
  scheduleWechatCopyrightProofCleanup()
  directUploadCoordinator.registerHandlers()
  catalogUploadCoordinator.registerHandlers()

  ipcMain.handle('wechat-miniprogram-drama:config:get', () => ({
    config: readConfig(),
    path: configPath(),
    restartRequired: false,
  }))

  ipcMain.handle('wechat-miniprogram-drama:config:save', async (_event, config: WechatMiniProgramConfig) => {
    const nextConfig = normalizeConfig(config)
    writeConfig(nextConfig)
    registerWechatMiniProgramRuntimeAssetCleanup(readConfig())
    const result = {
      config: nextConfig,
      path: configPath(),
      restartRequired: runtimeController.running || runtimeController.startingPromise !== null,
    }
    broadcastConfigChanged(result)
    return result
  })

  ipcMain.handle('wechat-miniprogram-drama:config:select-local-episode-video-root', async (event, currentPath?: string) => {
    return selectDirectory(event, {
      title: '选择剧集视频根目录',
      defaultPath: directoryDefaultPath(currentPath, app.getPath('videos')),
      properties: ['openDirectory', 'createDirectory'],
    })
  })

  ipcMain.handle('wechat-miniprogram-drama:config:select-run-data-dir', async (event, currentPath?: string) => {
    const selectedPath = await selectDirectory(event, {
      title: '选择运行数据目录',
      defaultPath: directoryDefaultPath(currentPath, app.getPath('documents')),
      properties: ['openDirectory', 'createDirectory'],
    })

    return normalizePlatformRunDataDir(selectedPath, 'wechat-miniprogram-drama')
  })

  ipcMain.handle('wechat-miniprogram-drama:service:status', () => status())

  ipcMain.handle('wechat-miniprogram-drama:service:start', async () => {
    if (directUploadCoordinator.isActive()) {
      throw new Error('百度资源直传正在运行或浏览器尚未关闭，请先暂停队列并关闭直传浏览器。')
    }
    assertGlobalDirectoriesConfigured()
    assertWechatMiniProgramConfigReady()
    await runtimeController.start(startRuntime)
    return status()
  })

  ipcMain.handle('wechat-miniprogram-drama:service:stop', async () => {
    await runtimeController.stop()
    return status()
  })

  ipcMain.handle('wechat-miniprogram-drama:service:video-account:focus', async (_event, videoAccountId: string) => {
    if (videoAccountId === directUploadBrowserId) {
      await directUploadCoordinator.focusBrowser()
      return status()
    }
    const runtime = await runtimeController.resolveStarting()

    if (!runtime) {
      throw new Error('微信小程序服务未启动。')
    }

    let currentRuntime = runtime
    if (typeof currentRuntime.focusVideoAccount !== 'function') {
      currentRuntime = await runtimeController.replace(startRuntime)
    }

    if (typeof currentRuntime.focusVideoAccount !== 'function') {
      throw new Error('当前微信小程序服务实例不支持打开浏览器到前台，请重启应用后再试。')
    }

    await currentRuntime.focusVideoAccount(videoAccountId)
    return status()
  })

  ipcMain.handle('wechat-miniprogram-drama:service:video-account:open-log', async (_event, videoAccountId: string) => {
    return openExistingPath(findLatestVideoAccountLogFile(videoAccountId))
  })
}

export function stopWechatMiniProgramPlatformRuntime() {
  runtimeController.stopInBackground()
  void directUploadCoordinator.stop()
  void catalogUploadCoordinator.stop()
}

export async function stopWechatMiniProgramPlatformService() {
  await Promise.all([
    runtimeController.stop(),
    directUploadCoordinator.stop(),
    catalogUploadCoordinator.stop(),
  ])
}
