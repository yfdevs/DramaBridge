import { createConfiguredAiClient, getConfiguredAiImageModel, getConfiguredAiCoverGenerationRetryAttempts } from "../../global-app-config";
import { ensureBaiduNetdiskShareDownloaded, kuaishouRecreationMaterialRoot, uploadKuaishouRecreationVersion, transferKuaishouRecreationVideos } from "../baidu-netdisk";
import { createRecreationBundleTransfer } from "./recreation-bundle-workflow";

export const transferKuaishouRecreationBundle = createRecreationBundleTransfer({
  createConfiguredAiClient, getConfiguredAiImageModel, getConfiguredAiCoverGenerationRetryAttempts,
  ensureBaiduNetdiskShareDownloaded, kuaishouRecreationMaterialRoot, uploadKuaishouRecreationVersion, transferKuaishouRecreationVideos,
});
