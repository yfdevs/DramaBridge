import path from "node:path";
import { fileURLToPath } from "node:url";

export type AppEnvironment = {
  appRoot: string;
  devServerUrl?: string;
  mainDist: string;
  publicDir: string;
  rendererDist: string;
};

export function initializeAppEnvironment(entryUrl: string): AppEnvironment {
  const mainDist = path.dirname(fileURLToPath(entryUrl));
  const appRoot = path.join(mainDist, "..");
  const rendererDist = path.join(appRoot, "dist");
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const publicDir = devServerUrl ? path.join(appRoot, "public") : rendererDist;

  // Several platform boot boundaries still consume these infrastructure paths.
  // Define them once, before any handler starts, instead of recomputing them.
  process.env.APP_ROOT = appRoot;
  process.env.VITE_PUBLIC = publicDir;

  return { appRoot, devServerUrl, mainDist, publicDir, rendererDist };
}
