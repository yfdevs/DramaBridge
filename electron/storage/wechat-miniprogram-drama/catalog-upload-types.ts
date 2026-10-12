export type WechatMiniProgramCatalogUploadState =
  | "discovered"
  | "missing-source"
  | "downloading"
  | "uploading"
  | "completed"
  | "failed"
  | "interrupted"

export type WechatMiniProgramCatalogEpisodeStatus = {
  episodeNo: number
  state: "pending" | "uploaded" | "existing" | "failed"
  materialId?: string
  fileName?: string
  error?: string
}

export type WechatMiniProgramCatalogCoverStatus =
  | "pending"
  | "uploaded"
  | "existing"
  | "failed"

export type WechatMiniProgramCatalogUploadTask = {
  id: string
  dramaId: number
  wxDramaId?: number
  dramaName: string
  dramaDescription?: string
  episodeCount: number
  baiduNetdiskUrl?: string
  hasFirstFourEpisodes: boolean
  hasCover: boolean
  lifecycleStatus?: string
  auditStatus?: number
  expectedPublishStatus?: string
  actualPublishStatus?: string
  operationStatus?: string
  state: WechatMiniProgramCatalogUploadState
  targetEpisodeCount: number
  uploadedEpisodeCount: number
  episodeStatuses: WechatMiniProgramCatalogEpisodeStatus[]
  coverStatus: WechatMiniProgramCatalogCoverStatus
  coverMaterialId?: string
  coverFileName?: string
  coverError?: string
  workflowVersion: number
  localPath?: string
  error?: string
  retryCount: number
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
}

export type WechatMiniProgramCatalogUploadTaskRow = Omit<
  WechatMiniProgramCatalogUploadTask,
  "wxDramaId" | "dramaDescription" | "baiduNetdiskUrl" | "hasFirstFourEpisodes" | "hasCover" | "lifecycleStatus" |
  "auditStatus" | "expectedPublishStatus" | "actualPublishStatus" | "operationStatus" |
  "episodeStatuses" | "coverMaterialId" | "coverFileName" | "coverError" |
  "localPath" | "error" | "startedAt" | "finishedAt"
> & {
  wxDramaId: number | null
  dramaDescription: string | null
  baiduNetdiskUrl: string | null
  hasFirstFourEpisodes: number
  hasCover: number
  lifecycleStatus: string | null
  auditStatus: number | null
  expectedPublishStatus: string | null
  actualPublishStatus: string | null
  operationStatus: string | null
  episodeStatusesJson: string
  coverMaterialId: string | null
  coverFileName: string | null
  coverError: string | null
  localPath: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}
