import { createRequire } from "node:module";
import * as nodeFs from "node:fs";

// Runtime archives and app bundles are physical installation artifacts.
// Electron's patched fs exposes *.asar as virtual directories, which changes
// their digests and can make recursive removal fail with ENOTEMPTY. Keep this
// boundary local; process.noAsar would change every concurrent app operation.
const require = createRequire(import.meta.url);
export const artifactFileSystem: typeof nodeFs = process.versions.electron
  ? require("original-fs") as typeof nodeFs
  : nodeFs;
