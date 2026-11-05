export type NetdiskDramaInput = {
  title: string; episodeCount: number; copyright: string; production: string;
  subject: string; genre: string; description: string; shareText: string; flatLink: string;
  sheet: string; sourceRow: number;
};
export type NetdiskDramaRecord = NetdiskDramaInput & {
  id: number; batchId: string; importedAt: string; sourceFile: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  generatedLink: string;
  progress: number; progressStage: string;
  error: string; targetPath: string; completedAt: string | null;
};
export type NetdiskDramaQuery = { search?: string; from?: string; to?: string; status?: string; page?: number };
export type NetdiskDramaList = { records: NetdiskDramaRecord[]; total: number; running: boolean };
