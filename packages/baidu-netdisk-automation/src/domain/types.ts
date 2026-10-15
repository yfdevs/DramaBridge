export type CdpTarget = {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

export type CdpMessage = {
  id?: number;
  method?: string;
  params?: {
    type?: string;
    args?: Array<{
      value?: unknown;
      description?: string;
    }>;
  };
  result?: unknown;
  error?: unknown;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BaiduNetdiskShareInfo = {
  link: string;
  pwd: string;
  name: string;
};

export type ShareInfo = BaiduNetdiskShareInfo;

export type BaiduNetdiskTemporaryTransfer = {
  path: string;
  fsId: number | string;
  createdByAutomation: true;
};

export type BaiduNetdiskShareDownloadOptions = {
  shareText?: string;
  shareFile?: string;
  resourceName?: string;
  expectedEpisodeCount?: number;
  /** Download only episodes 1..N. Omit to preserve the full-directory download flow. */
  episodeDownloadLimit?: number;
  inferEpisodeCount?: boolean;
  expectedOwnershipCounts?: {
    minimumImages?: number;
  };
  expectedOwnershipFiles?: number;
  expectedPosterImages?: number;
  expectedAiProductionProofFiles?: number;
  expectedMetadataTextFiles?: number;
  downloadEpisodeVideos?: boolean;
  downloadAssetMaterials?: boolean;
  requireAllDiscoveredAssets?: boolean;
  port?: number;
  downloadDir?: string;
  signal?: AbortSignal;
  onTemporaryTransferCreated?: (
    transfer: BaiduNetdiskTemporaryTransfer,
  ) => void | Promise<void>;
  selectEpisodeFiles?: (request: {
    resourceName: string;
    expectedEpisodeCount?: number;
    candidates: Array<{
      id: number;
      index?: number;
      name: string;
      path: string;
      size?: number;
    }>;
  }) => Promise<Array<{ path: string; index: number }>>;
};

export type BaiduNetdiskRemoteOwnershipFile = {
  index?: number;
  name: string;
  path: string;
  fsId?: number | string;
  size?: number;
  proofKind?: "jianying" | "juchuang";
};

export type BaiduNetdiskRemoteEpisodeFile = {
  index: number;
  name: string;
  path: string;
  fsId?: number | string;
  size?: number;
  contentHash?: string;
};

export type BaiduNetdiskRemoteVideoListing = {
  rootPath: string;
  files: BaiduNetdiskRemoteEpisodeFile[];
  allVideoFiles: Array<{
    name: string;
    path: string;
    size?: number;
  }>;
  unmatchedVideoFiles?: Array<{
    name: string;
    path: string;
    size?: number;
  }>;
  ignoredIdenticalAliases?: Array<{
    index: number;
    name: string;
    path: string;
    size?: number;
    contentHash?: string;
    keptPath: string;
  }>;
  scannedDirs?: Array<{
    path: string;
    name?: string;
    fsId?: string;
    errno?: number;
    count: number;
    fileCount?: number;
    fileSizeBytes?: number;
    mp4Count?: number;
    mp4SizeBytes?: number;
    hasMore?: boolean;
    entries: Array<{
      name: string;
      path: string;
      isDir: boolean;
      size?: number;
    }>;
  }>;
  duplicateIndexes: number[];
  missingIndexes?: number[];
  aiSelectionApplied?: boolean;
};

export type BaiduNetdiskRemoteOwnershipListing = {
  files: BaiduNetdiskRemoteOwnershipFile[];
  allFiles: BaiduNetdiskRemoteOwnershipFile[];
  roots: Array<{ path: string; fsId?: number | string }>;
  rootPath?: string;
  rootFsId?: number | string;
};

export type BaiduNetdiskRemotePosterListing = {
  files: BaiduNetdiskRemoteOwnershipFile[];
  roots: Array<{ path: string; fsId?: number | string }>;
};

export type BaiduNetdiskRemoteAiProductionProofListing = {
  files: BaiduNetdiskRemoteOwnershipFile[];
  roots: Array<{ path: string; fsId?: number | string }>;
};

export type BaiduNetdiskRemoteMetadataListing = {
  files: BaiduNetdiskRemoteOwnershipFile[];
  textFiles: BaiduNetdiskRemoteOwnershipFile[];
  roots: Array<{ path: string; fsId?: number | string }>;
};

export type BaiduNetdiskShareDownloadResult = {
  share: BaiduNetdiskShareInfo;
  downloadRoot?: string;
  localPath?: string;
  remoteVideos?: BaiduNetdiskRemoteVideoListing;
  remoteOwnership?: BaiduNetdiskRemoteOwnershipListing;
  remotePosters?: BaiduNetdiskRemotePosterListing;
  remoteAiProductionProofs?: BaiduNetdiskRemoteAiProductionProofListing;
  remoteMetadata?: BaiduNetdiskRemoteMetadataListing;
  expectedOwnershipImages?: number;
  expectedOwnershipFiles?: number;
  expectedPosterImages?: number;
  expectedAiProductionProofFiles?: number;
  expectedMetadataTextFiles?: number;
  expectedMetadataFiles?: number;
  inferredEpisodeCount?: number;
  temporaryTransfer?: BaiduNetdiskTemporaryTransfer;
  remoteResourceRoot?: {
    path: string;
    fsId: number | string;
  };
  completed: boolean;
  skippedExisting: boolean;
};

export type BaiduNetdiskDownloadTaskStatus = {
  found: boolean;
  name?: string;
  localPath?: string;
  status?: string;
  size?: number;
  finishSize?: number;
  rate?: string;
  completed: boolean;
  tasks: string[];
};
