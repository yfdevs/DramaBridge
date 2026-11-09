import { execa } from "execa";
import console from "node:console";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { packagingTarget } from "./packaging-target.mjs";

const args = process.argv.slice(2).filter(arg => arg !== "--");
const allowed = new Set(["--arm64", "--dir"]);
try {
  packagingTarget(["--mac", ...args]);
  if (args.some(arg => !allowed.has(arg))) throw new Error("Usage: pnpm build:mac [--arm64] [--dir]");
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  await execa("pnpm", ["build:app"], { cwd, stdio: "inherit", preferLocal: true });
  await execa(process.execPath, ["scripts/package-electron-hoisted.mjs", "--mac", "--arm64", "--publish", "never",
    ...(args.includes("--dir") ? ["--dir"] : [])], { cwd, stdio: "inherit" });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
