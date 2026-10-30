export type RecreationInput = {
  originalTitle: string;
  episodeCount: number;
  shareText: string;
  versions: string[];
};
export type RecreationVersion = {
  title: string;
  localPath?: string;
  localFiles?: Array<{ path: string; size: number; modifiedAtMs: number }>;
  verifiedFiles?: Array<{ path: string; fsId: string; size: number; serverMd5: string; serverMtime: number; contentMd5: string }>;
  remotePath?: string;
  shareUrl?: string;
  extractionCode?: string;
};
export type RecreationTask = RecreationInput & {
  id: string;
  state:
    | "queued"
    | "checking"
    | "downloading"
    | "processing"
    | "uploading"
    | "completed"
    | "failed"
    | "interrupted";
  downloadCount: number;
  results: RecreationVersion[];
  localPath?: string;
  sourcePath?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
};
export type RecreationWorkspace = { running: boolean; tasks: RecreationTask[] };
