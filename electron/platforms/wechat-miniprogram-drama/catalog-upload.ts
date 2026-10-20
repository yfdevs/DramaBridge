import { BrowserWindow, ipcMain } from "electron"
import { createHash } from "node:crypto"
import { openAsBlob } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { ensureBaiduNetdiskShareDownloaded } from "../baidu-netdisk"
import { createElectronPlatformLogger } from "../../platform-logger"
import {
  createConfiguredAiClient,
  getConfiguredAiCoverGenerationRetryAttempts,
  getConfiguredAiImageModel,
  isAiPosterFallbackEnabled,
} from "../../global-app-config"
import {
  configureNativeChildWindow,
  platformWindowIconPath,
  resolveFromAppRoot,
} from "../shared"
import { WechatMiniProgramCatalogUploadTaskRepository } from "../../storage/wechat-miniprogram-drama/catalog-upload-repository"
import type {
  WechatMiniProgramCatalogCoverStatus,
  WechatMiniProgramCatalogEpisodeStatus,
  WechatMiniProgramCatalogUploadTask,
} from "../../storage/wechat-miniprogram-drama/catalog-upload-types"
import { catalogMaterialUploadUrl } from "./catalog-upload-request"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const windowMode = "wechat-miniprogram-catalog-upload"
const windowTitle = "剧目前四集与封面入库"
const pageSize = 100
const requestedEpisodeCount = 4
const eligibleAuditStatus = 3

type Settings = {
  catalogApiBaseUrl: string
  localEpisodeVideoRoot: string
  runDataDir: string
  logRetentionDays?: string
}

type CatalogDrama = {
  id: number
  wxDramaId?: number | null
  name: string
  dramaDescription?: string | null
  description?: string | null
  summary?: string | null
  synopsis?: string | null
  introduction?: string | null
  intro?: string | null
  episodeCount: number
  baiduNetdiskUrl?: string | null
  hasFirstFourEpisodes?: boolean
  hasCover?: boolean
  lifecycleStatus?: string | null
  auditStatus?: number | null
  expectedPublishStatus?: string | null
  actualPublishStatus?: string | null
  operationStatus?: string | null
}

type MaterialView = {
  id?: number
  materialType?: string
  originalFilename?: string
  fileName?: string
  materialId?: string
  dramaId?: number
  episodeNo?: number
  slotNo?: number
  current?: boolean | null
  uploadStatus?: string
}

type ApiResponse<T> = {
  code: number
  message?: string
  data: T
}

type DramaPage = {
  items: CatalogDrama[]
  page: number
  size: number
  totalElements: number
  totalPages: number
}

export type WechatMiniProgramCatalogUploadWorkspace = {
  queue: {
    running: boolean
    activeTaskId?: string
    processedCount: number
    totalCount: number
    error?: string
  }
  sync: {
    running: boolean
    currentPage: number
    totalPages?: number
    syncedCount: number
    lastSyncedAt?: string
    error?: string
  }
  tasks: WechatMiniProgramCatalogUploadTask[]
  databasePath: string
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function apiUrl(baseUrl: string, pathname: string): URL {
  return new URL(pathname, `${baseUrl.replace(/\/+$/, "")}/`)
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = "AbortError"
  return error
}

function videoContentType(file: string): string {
  return path.extname(file).toLowerCase() === ".mov" ? "video/quicktime" : "video/mp4"
}

function imageContentType(file: string): string {
  const extension = path.extname(file).toLowerCase()
  if (extension === ".png") return "image/png"
  if (extension === ".webp") return "image/webp"
  return "image/jpeg"
}

function materialIdentifier(material: MaterialView): string | undefined {
  return material.materialId ?? (material.id === undefined ? undefined : String(material.id))
}

function catalogDramaDescription(drama: CatalogDrama): string | undefined {
  return [
    drama.dramaDescription,
    drama.description,
    drama.summary,
    drama.synopsis,
    drama.introduction,
    drama.intro,
  ]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
    ?.trim()
}

async function cachedEpisodeReferenceFrames(options: {
  episodeFile: string
  localMaterialRoot: string
  resourceName: string
  signal: AbortSignal
  onLog: (message: string) => void
}) {
  const episodeStat = await stat(options.episodeFile)
  const episodeKey = createHash("sha256")
    .update(path.resolve(options.episodeFile).toLowerCase())
    .update(String(episodeStat.size))
    .update(String(episodeStat.mtimeMs))
    .digest("hex")
    .slice(0, 16)
  const outputDir = path.join(
    options.localMaterialRoot,
    options.resourceName,
    "海报封面",
    "AI参考帧",
    episodeKey,
  )
  const cachedCandidates = (await readdir(outputDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /^frame-\d+-.+\.jpg$/i.test(entry.name))
    .map((entry) => path.join(outputDir, entry.name))
    .sort()
  const cached: string[] = []
  for (const file of cachedCandidates) {
    const fileStat = await stat(file).catch(() => undefined)
    if (fileStat?.isFile() && fileStat.size > 0) cached.push(file)
    if (cached.length === 2) break
  }
  if (cached.length === 2) {
    options.onLog("复用第一集已抽取的两张 AI 参考帧")
    return cached
  }

  const { extractRandomVideoFrames } = await import("@dramabridge/media-assets")
  const extracted = await extractRandomVideoFrames({
    inputFile: options.episodeFile,
    outputDir,
    count: 2,
    signal: options.signal,
    onLog: options.onLog,
  })
  return extracted.files
}

export class WechatMiniProgramCatalogUploadCoordinator {
  private readonly repository = new WechatMiniProgramCatalogUploadTaskRepository()
  private queueRunning = false
  private queueError: string | undefined
  private activeTaskId: string | undefined
  private processedCount = 0
  private totalCount = 0
  private syncing = false
  private syncCurrentPage = 0
  private syncTotalPages: number | undefined
  private syncedCount = 0
  private lastSyncedAt: string | undefined
  private syncError: string | undefined
  private syncPromise: Promise<void> | null = null
  private workerPromise: Promise<void> | null = null
  private abortController: AbortController | null = null
  private window: BrowserWindow | null = null

  constructor(private readonly options: { getSettings: () => Settings }) {
    this.repository.recoverInterrupted()
  }

  registerHandlers(): void {
    ipcMain.handle("wechat-miniprogram-drama:catalog-upload:window:open", () => {
      this.openWindow()
      return this.workspace()
    })
    ipcMain.handle(
      "wechat-miniprogram-drama:catalog-upload:workspace:get",
      () => this.workspace(),
    )
    ipcMain.handle("wechat-miniprogram-drama:catalog-upload:queue:start", () => {
      this.startQueue()
      return this.workspace()
    })
    ipcMain.handle("wechat-miniprogram-drama:catalog-upload:catalog:sync", async () => {
      await this.syncCatalog()
      return this.workspace()
    })
    ipcMain.handle("wechat-miniprogram-drama:catalog-upload:queue:pause", () => {
      this.queueRunning = false
      this.broadcast()
      return this.workspace()
    })
    ipcMain.handle("wechat-miniprogram-drama:catalog-upload:task:cancel-active", async () => {
      if (!this.activeTaskId) throw new Error("当前没有正在执行的任务。")
      this.queueRunning = false
      this.abortController?.abort(abortError("用户已终止当前任务。"))
      this.broadcast()
      return this.workspace()
    })
    ipcMain.handle(
      "wechat-miniprogram-drama:catalog-upload:task:retry",
      (_event, id: string) => {
        this.repository.retry(id)
        this.startQueue()
        return this.workspace()
      },
    )
    ipcMain.handle(
      "wechat-miniprogram-drama:catalog-upload:tasks:retry",
      (_event, ids: string[]) => {
        if (!Array.isArray(ids)) throw new Error("批量重试参数无效。")
        const requestedIds = new Set(ids.filter((id) => typeof id === "string"))
        const retryableIds = new Set(
          this.repository.list()
            .filter((task) => (
              requestedIds.has(task.id)
              && ["failed", "interrupted"].includes(task.state)
              && Boolean(task.baiduNetdiskUrl?.trim())
            ))
            .map((task) => task.id),
        )
        if (retryableIds.size === 0) throw new Error("没有可重试的失败任务。")
        for (const id of retryableIds) this.repository.retry(id)
        this.startQueue()
        return this.workspace()
      },
    )
  }

  workspace(): WechatMiniProgramCatalogUploadWorkspace {
    return {
      queue: {
        running: this.queueRunning,
        activeTaskId: this.activeTaskId,
        processedCount: this.processedCount,
        totalCount: this.totalCount,
        error: this.queueError,
      },
      sync: {
        running: this.syncing,
        currentPage: this.syncCurrentPage,
        totalPages: this.syncTotalPages,
        syncedCount: this.syncedCount,
        lastSyncedAt: this.lastSyncedAt,
        error: this.syncError,
      },
      tasks: this.repository.list(),
      databasePath: this.repository.databasePath,
    }
  }

  isActive(): boolean {
    return this.queueRunning || Boolean(this.activeTaskId) || this.syncing
  }

  async stop(): Promise<void> {
    this.queueRunning = false
    this.abortController?.abort(abortError("应用正在退出，当前任务已中断。"))
    await this.workerPromise?.catch(() => undefined)
    this.window?.destroy()
    this.window = null
  }

  private startQueue(): void {
    const settings = this.options.getSettings()
    if (!settings.localEpisodeVideoRoot.trim()) {
      throw new Error("请先在微信小程序配置中设置剧集视频根目录。")
    }
    if (this.syncing) throw new Error("正在获取全部剧目，请等待同步完成后再开始处理。")
    if (this.queueRunning) return
    const queuedTasks = this.repository.list().filter(
      (task) => task.state === "discovered",
    )
    if (queuedTasks.length === 0) {
      throw new Error("没有等待处理的剧目，请先点击“获取全部剧目”。")
    }
    this.queueRunning = true
    this.queueError = undefined
    this.processedCount = 0
    this.totalCount = queuedTasks.length
    this.broadcast()
    if (!this.workerPromise) {
      this.workerPromise = this.runQueue().finally(() => {
        this.workerPromise = null
        this.queueRunning = false
        this.activeTaskId = undefined
        this.broadcast()
      })
    }
  }

  private async runQueue(): Promise<void> {
    try {
      const tasks = this.repository.list().filter(
        (task) => task.state === "discovered",
      )
      this.totalCount = tasks.length
      for (const task of tasks) {
        if (!this.queueRunning) break
        if (task.targetEpisodeCount <= 0) {
          this.repository.update(task.id, {
            state: "failed",
            error: "剧列表中的总集数无效。",
            finishedAt: new Date().toISOString(),
          })
        } else {
          await this.processTask(task)
        }
        this.processedCount += 1
        this.broadcast()
      }
    } catch (error) {
      const message = readableError(error)
      if (!(error instanceof Error && error.name === "AbortError")) {
        this.queueError = message
        this.logger().error("Catalog upload queue stopped", { errorMessage: message })
      }
    }
  }

  private async syncCatalog(): Promise<void> {
    if (this.queueRunning || this.activeTaskId) {
      throw new Error("前四集与封面队列正在处理，请暂停并等待当前剧目结束后再获取全部剧目。")
    }
    if (this.syncPromise) return this.syncPromise
    this.syncing = true
    this.syncError = undefined
    this.syncCurrentPage = 0
    this.syncTotalPages = undefined
    this.syncedCount = 0
    this.broadcast()
    this.syncPromise = (async () => {
      try {
        const firstPage = await this.fetchDramaPage(0)
        this.syncTotalPages = Math.max(1, firstPage.totalPages)
        const dramas = [...firstPage.items]
        this.syncedCount = dramas.length
        this.broadcast()
        for (let page = 1; page < this.syncTotalPages; page += 1) {
          this.syncCurrentPage = page
          const result = await this.fetchDramaPage(page)
          dramas.push(...result.items)
          this.syncedCount = dramas.length
          this.broadcast()
        }
        // The catalog API applies auditStatus=3 server-side. Use the returned
        // page set directly so the desktop app does not maintain a second,
        // potentially divergent copy of the filtering rule.
        const eligibleDramaIds = new Set(dramas.map((drama) => drama.id))
        const staleDramaIds = this.repository.list()
          .filter((task) => !eligibleDramaIds.has(task.dramaId))
          .map((task) => task.dramaId)
        const deletedCount = this.repository.deleteByDramaIds(staleDramaIds)
        this.repository.upsertDiscoveredBatch(dramas.map((drama) => ({
          dramaId: drama.id,
          wxDramaId: drama.wxDramaId ?? undefined,
          dramaName: drama.name,
          dramaDescription: catalogDramaDescription(drama),
          episodeCount: drama.episodeCount,
          baiduNetdiskUrl: drama.baiduNetdiskUrl?.trim() || undefined,
          hasFirstFourEpisodes: Boolean(drama.hasFirstFourEpisodes),
          hasCover: Boolean(drama.hasCover),
          lifecycleStatus: drama.lifecycleStatus ?? undefined,
          auditStatus: drama.auditStatus ?? undefined,
          expectedPublishStatus: drama.expectedPublishStatus ?? undefined,
          actualPublishStatus: drama.actualPublishStatus ?? undefined,
          operationStatus: drama.operationStatus ?? undefined,
          targetEpisodeCount: Math.min(
            requestedEpisodeCount,
            Math.max(0, Math.floor(Number(drama.episodeCount) || 0)),
          ),
        })))
        this.lastSyncedAt = new Date().toISOString()
        this.logger().info("All catalog dramas synchronized", {
          dramaCount: dramas.length,
          auditStatus: eligibleAuditStatus,
          deletedStaleDramaCount: deletedCount,
          pageCount: this.syncTotalPages,
        })
      } catch (error) {
        this.syncError = readableError(error)
        throw error
      } finally {
        this.syncing = false
        this.syncPromise = null
        this.broadcast()
      }
    })()
    return this.syncPromise
  }

  private async processTask(task: WechatMiniProgramCatalogUploadTask): Promise<void> {
    const controller = new AbortController()
    this.abortController = controller
    this.activeTaskId = task.id
    const logger = this.logger(task)
    const targetEpisodeCount = task.targetEpisodeCount
    try {
      this.repository.update(task.id, {
        state: "downloading",
        error: undefined,
        startedAt: new Date().toISOString(),
        finishedAt: undefined,
      })
      this.broadcast()
      const settings = this.options.getSettings()
      const existingMaterials = await this.fetchMaterials(task.dramaId, controller.signal)
      controller.signal.throwIfAborted()
      const expectedIndexes = Array.from({ length: targetEpisodeCount }, (_, index) => index + 1)
      let statuses: WechatMiniProgramCatalogEpisodeStatus[] = existingMaterials
        .filter((material) =>
          material.materialType === "EPISODE_VIDEO"
          && material.current !== false
          && material.uploadStatus !== "FAILED"
          && Number.isInteger(Number(material.episodeNo))
          && Number(material.episodeNo) >= 1
          && Number(material.episodeNo) <= targetEpisodeCount,
        )
        .map((material) => ({
          episodeNo: Number(material.episodeNo),
          state: "existing" as const,
          materialId: materialIdentifier(material),
          fileName: material.originalFilename ?? material.fileName,
        }))
        .filter((status, index, all) =>
          all.findIndex((candidate) => candidate.episodeNo === status.episodeNo) === index,
        )
        .sort((left, right) => left.episodeNo - right.episodeNo)
      if (task.hasFirstFourEpisodes) {
        for (const episodeNo of expectedIndexes) {
          if (!statuses.some((status) => status.episodeNo === episodeNo)) {
            statuses.push({ episodeNo, state: "existing" })
          }
        }
        statuses.sort((left, right) => left.episodeNo - right.episodeNo)
      }
      let uploadedEpisodeCount = statuses.length
      const existingCover = existingMaterials.find((material) =>
        material.materialType === "DRAMA_COVER"
        && material.current !== false
        && material.uploadStatus !== "FAILED",
      )
      const coverAlreadyExists = task.hasCover || Boolean(existingCover)
      let coverStatus: WechatMiniProgramCatalogCoverStatus = coverAlreadyExists ? "existing" : "pending"
      let coverMaterialId = existingCover ? materialIdentifier(existingCover) : undefined
      let coverFileName = existingCover?.originalFilename ?? existingCover?.fileName
      this.repository.update(task.id, {
        episodeStatuses: statuses,
        uploadedEpisodeCount,
        coverStatus,
        coverMaterialId,
        coverFileName,
        coverError: undefined,
      })
      this.broadcast()

      const missingEpisodeIndexes = expectedIndexes.filter(
        (episodeNo) => !statuses.some((status) => status.episodeNo === episodeNo),
      )
      const downloadEpisodeVideos = missingEpisodeIndexes.length > 0
      const downloadCover = !coverAlreadyExists
      const needsDownload = downloadEpisodeVideos || downloadCover
      const episodeDownloadCount = downloadEpisodeVideos
        ? targetEpisodeCount
        : downloadCover ? 1 : 0
      let localPath = task.localPath
      if (needsDownload) {
        if (!downloadEpisodeVideos && downloadCover) {
          logger.info("First episodes already exist; downloading cover material and episode 1 for AI fallback", {
            dramaId: task.dramaId,
            existingEpisodeCount: statuses.length,
          })
        }
        const download = await ensureBaiduNetdiskShareDownloaded({
          requesterPlatform: "wechat-miniprogram-drama-catalog-upload",
          shareText: task.baiduNetdiskUrl ?? "",
          resourceName: task.dramaName,
          localEpisodeVideoRoot: settings.localEpisodeVideoRoot,
          episodeCount: episodeDownloadCount,
          episodeDownloadLimit: episodeDownloadCount || undefined,
          downloadEpisodeVideos: episodeDownloadCount > 0,
          downloadAssetMaterials: downloadCover,
          requiredOwnership: { minimumImages: 0 },
          requiredOwnershipFiles: 0,
          requiredPosterImages: 0,
          requiredAiProductionProofFiles: 0,
          signal: controller.signal,
        })
        localPath = download.localPath
      }
      controller.signal.throwIfAborted()

      const { ensureAiPoster, findLocalEpisodeVideos, listLocalPosterImages } = await import("@dramabridge/media-assets")
      const localEpisodeVideos = episodeDownloadCount > 0
        ? (await findLocalEpisodeVideos({
            localEpisodeVideoRoot: settings.localEpisodeVideoRoot,
            resourceName: task.dramaName,
          })).filter((episode) => episode.index <= targetEpisodeCount)
        : []
      const episodeVideos = missingEpisodeIndexes.length > 0 ? localEpisodeVideos : []
      if (missingEpisodeIndexes.length > 0) {
        const actualIndexes = episodeVideos.map((episode) => episode.index)
        if (
          actualIndexes.length !== expectedIndexes.length
          || actualIndexes.some((episode, index) => episode !== expectedIndexes[index])
        ) {
          throw new Error(
            `前${targetEpisodeCount}集下载校验失败：实际找到${actualIndexes.join("、") || "无"}。`,
          )
        }
      }

      let coverFile = coverAlreadyExists
        ? undefined
        : (await listLocalPosterImages({
            root: settings.localEpisodeVideoRoot,
            resourceName: task.dramaName,
          }))[0]?.file
      if (!coverAlreadyExists && !coverFile) {
        if (!isAiPosterFallbackEnabled()) {
          throw new Error("封面下载校验失败：百度网盘未提供海报，且全局 AI 封面兜底已关闭。")
        }
        let summary = task.dramaDescription?.trim()
        if (!summary) {
          try {
            const detail = await this.fetchDramaDetail(task.dramaId, controller.signal)
            summary = catalogDramaDescription(detail)
            if (summary) this.repository.update(task.id, { dramaDescription: summary })
          } catch (error) {
            logger.warn("Unable to load drama description for AI poster; continuing with episode frames", {
              errorMessage: readableError(error),
            })
          }
        }
        const firstEpisode = localEpisodeVideos.find((episode) => episode.index === 1)
        if (!firstEpisode) {
          throw new Error("百度网盘未提供海报，AI 兜底生成未找到已下载的第一集视频。")
        }
        summary ||= "接口未提供剧情简介，请结合剧名和第一集参考画面理解主要人物、时代背景、场景氛围与核心剧情冲突。"
        logger.warn("Baidu Netdisk did not provide a poster; generating one from episode frames", {
          firstEpisode: firstEpisode.file,
          summaryLength: summary.length,
        })
        const referenceImages = await cachedEpisodeReferenceFrames({
          episodeFile: firstEpisode.file,
          localMaterialRoot: settings.localEpisodeVideoRoot,
          resourceName: task.dramaName,
          signal: controller.signal,
          onLog: logger.callback("ai-poster"),
        })
        const generatedPoster = await ensureAiPoster({
          client: createConfiguredAiClient(),
          model: getConfiguredAiImageModel(),
          retryAttempts: getConfiguredAiCoverGenerationRetryAttempts(),
          localMaterialRoot: settings.localEpisodeVideoRoot,
          resourceName: task.dramaName,
          title: task.dramaName,
          summary,
          referenceImages,
          onLog: logger.callback("ai-poster"),
        })
        coverFile = generatedPoster.file
        logger.info("AI fallback poster generated from episode frames", {
          coverFile,
          referenceImages,
          reused: generatedPoster.reused,
        })
      }

      this.repository.update(task.id, {
        state: "uploading",
        localPath,
        episodeStatuses: statuses,
        uploadedEpisodeCount,
        coverStatus,
      })
      this.broadcast()

      for (const episode of episodeVideos) {
        controller.signal.throwIfAborted()
        const alreadyUploaded = statuses.find(
          (status) => status.episodeNo === episode.index
            && (status.state === "uploaded" || status.state === "existing"),
        )
        if (alreadyUploaded) continue
        try {
          const uploaded = await this.uploadEpisode(
            task.dramaId,
            episode.index,
            episode.file,
            controller.signal,
          )
          statuses = statuses.filter((status) => status.episodeNo !== episode.index)
          statuses.push({
            episodeNo: episode.index,
            state: "uploaded",
            materialId: materialIdentifier(uploaded),
            fileName: uploaded.originalFilename ?? uploaded.fileName ?? path.basename(episode.file),
          })
          statuses.sort((left, right) => left.episodeNo - right.episodeNo)
          uploadedEpisodeCount = statuses.filter(
            (status) => status.state === "uploaded" || status.state === "existing",
          ).length
          this.repository.update(task.id, {
            state: "uploading",
            episodeStatuses: statuses,
            uploadedEpisodeCount,
          })
          this.broadcast()
        } catch (error) {
          statuses = statuses.filter((status) => status.episodeNo !== episode.index)
          statuses.push({
            episodeNo: episode.index,
            state: "failed",
            fileName: path.basename(episode.file),
            error: readableError(error),
          })
          this.repository.update(task.id, { episodeStatuses: statuses })
          throw error
        }
      }

      if (coverFile) {
        try {
          const uploadedCover = await this.uploadCover(task.dramaId, coverFile, controller.signal)
          coverStatus = "uploaded"
          coverMaterialId = materialIdentifier(uploadedCover)
          coverFileName = uploadedCover.originalFilename
            ?? uploadedCover.fileName
            ?? path.basename(coverFile)
          this.repository.update(task.id, {
            hasCover: true,
            coverStatus,
            coverMaterialId,
            coverFileName,
            coverError: undefined,
          })
          this.broadcast()
        } catch (error) {
          this.repository.update(task.id, {
            coverStatus: "failed",
            coverFileName: path.basename(coverFile),
            coverError: readableError(error),
          })
          throw error
        }
      }

      this.repository.update(task.id, {
        state: "completed",
        hasFirstFourEpisodes: true,
        hasCover: true,
        uploadedEpisodeCount: targetEpisodeCount,
        episodeStatuses: statuses,
        coverStatus,
        coverMaterialId,
        coverFileName,
        coverError: undefined,
        error: undefined,
        finishedAt: new Date().toISOString(),
      })
      logger.info("First episodes and cover uploaded to drama materials", {
        dramaId: task.dramaId,
        episodeCount: targetEpisodeCount,
        coverStatus,
      })
    } catch (error) {
      const interrupted = controller.signal.aborted
        || (error instanceof Error && error.name === "AbortError")
      const message = readableError(error)
      this.repository.update(task.id, {
        state: interrupted ? "interrupted" : "failed",
        error: message,
        finishedAt: new Date().toISOString(),
      })
      if (interrupted) logger.warn("Catalog upload task interrupted", { errorMessage: message })
      else logger.error("Catalog upload task failed", { errorMessage: message })
    } finally {
      if (this.abortController === controller) this.abortController = null
      if (this.activeTaskId === task.id) this.activeTaskId = undefined
      this.broadcast()
    }
  }

  private async fetchDramaPage(page: number): Promise<DramaPage> {
    const settings = this.options.getSettings()
    const url = apiUrl(settings.catalogApiBaseUrl, "/admin/v1/dramas")
    url.searchParams.set("auditStatus", String(eligibleAuditStatus))
    url.searchParams.set("page", String(page))
    url.searchParams.set("size", String(pageSize))
    const response = await fetch(url, {
      headers: {
        accept: "application/json, text/plain, */*",
        "x-operator": "",
      },
    })
    return this.readApiResponse<DramaPage>(response, "读取剧列表失败")
  }

  private async fetchDramaDetail(dramaId: number, signal: AbortSignal): Promise<CatalogDrama> {
    const settings = this.options.getSettings()
    const response = await fetch(apiUrl(settings.catalogApiBaseUrl, `/admin/v1/dramas/${dramaId}`), {
      signal,
      headers: {
        accept: "application/json, text/plain, */*",
        "x-operator": "",
      },
    })
    return this.readApiResponse<CatalogDrama>(response, "读取剧目详情失败")
  }

  private async uploadEpisode(
    dramaId: number,
    episodeNo: number,
    file: string,
    signal: AbortSignal,
  ): Promise<MaterialView> {
    const settings = this.options.getSettings()
    const url = catalogMaterialUploadUrl(settings.catalogApiBaseUrl, dramaId, {
      materialType: "EPISODE_VIDEO",
      episodeNo,
    })
    const form = new FormData()
    form.append("file", await openAsBlob(file, { type: videoContentType(file) }), path.basename(file))
    const response = await fetch(url, {
      method: "POST",
      signal,
      body: form,
    })
    return this.readApiResponse<MaterialView>(response, `第${episodeNo}集上传失败`)
  }

  private async uploadCover(
    dramaId: number,
    file: string,
    signal: AbortSignal,
  ): Promise<MaterialView> {
    const settings = this.options.getSettings()
    const url = catalogMaterialUploadUrl(settings.catalogApiBaseUrl, dramaId, {
      materialType: "DRAMA_COVER",
    })
    const form = new FormData()
    form.append("file", await openAsBlob(file, { type: imageContentType(file) }), path.basename(file))
    const response = await fetch(url, {
      method: "POST",
      signal,
      body: form,
    })
    return this.readApiResponse<MaterialView>(response, "剧目封面上传失败")
  }

  private async fetchMaterials(dramaId: number, signal: AbortSignal): Promise<MaterialView[]> {
    const settings = this.options.getSettings()
    const response = await fetch(apiUrl(
      settings.catalogApiBaseUrl,
      `/admin/v1/dramas/${dramaId}/materials`,
    ), {
      signal,
      headers: {
        accept: "application/json, text/plain, */*",
        "x-operator": "",
      },
    })
    return this.readApiResponse<MaterialView[]>(response, "读取已入库素材失败")
  }

  private async readApiResponse<T>(response: Response, action: string): Promise<T> {
    const text = await response.text()
    let payload: ApiResponse<T> | undefined
    try {
      payload = JSON.parse(text) as ApiResponse<T>
    } catch {
      throw new Error(`${action}：HTTP ${response.status}，接口未返回 JSON。`)
    }
    if (!response.ok || payload.code !== 0) {
      throw new Error(`${action}：${payload.message || `HTTP ${response.status}`}`)
    }
    return payload.data
  }

  private openWindow(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show()
      this.window.focus()
      return
    }
    const window = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: windowTitle,
      icon: platformWindowIconPath("wechat-miniprogram.png"),
      autoHideMenuBar: true,
      backgroundColor: "#fafafa",
      webPreferences: {
        preload: path.join(__dirname, "preload.mjs"),
        sandbox: false,
      },
    })
    this.window = window
    configureNativeChildWindow(window, windowTitle)
    window.once("ready-to-show", () => window.show())
    window.on("closed", () => {
      if (this.window === window) this.window = null
    })
    const devServerUrl = process.env.VITE_DEV_SERVER_URL
    if (devServerUrl) {
      const url = new URL(devServerUrl)
      url.searchParams.set("window", windowMode)
      void window.loadURL(url.toString())
    } else {
      void window.loadFile(
        path.join(process.env.APP_ROOT ?? path.join(__dirname, "..", ".."), "dist", "index.html"),
        { query: { window: windowMode } },
      )
    }
  }

  private broadcast(): void {
    const workspace = this.workspace()
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(
        "wechat-miniprogram-drama:catalog-upload:workspace:changed",
        workspace,
      )
    }
  }

  private logger(task?: WechatMiniProgramCatalogUploadTask) {
    const settings = this.options.getSettings()
    return createElectronPlatformLogger({
      platform: "wechat-miniprogram-drama",
      scope: "catalog-first-episodes",
      context: task ? { taskId: task.id, dramaId: task.dramaId, dramaName: task.dramaName } : undefined,
      logDir: path.join(resolveFromAppRoot(settings.runDataDir), "logs"),
      retentionDays: Number.parseInt(settings.logRetentionDays ?? "3", 10) || 3,
    })
  }
}
