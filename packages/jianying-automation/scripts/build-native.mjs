import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frameworkRoot = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319");
const compilerPath = path.join(frameworkRoot, "csc.exe");
const outputDirectory = path.join(packageRoot, "native", "bin");
const outputPath = path.join(outputDirectory, "JianyingUia.exe");

await mkdir(outputDirectory, { recursive: true });
await execa(compilerPath, [
  "/nologo",
  "/target:exe",
  "/platform:x64",
  `/out:${outputPath}`,
  `/reference:${path.join(frameworkRoot, "WPF", "UIAutomationClient.dll")}`,
  `/reference:${path.join(frameworkRoot, "WPF", "UIAutomationTypes.dll")}`,
  `/reference:${path.join(frameworkRoot, "WPF", "WindowsBase.dll")}`,
  `/reference:${path.join(frameworkRoot, "System.Web.Extensions.dll")}`,
  `/reference:${path.join(frameworkRoot, "System.Drawing.dll")}`,
  path.join(packageRoot, "native", "JianyingUia.cs"),
], { windowsHide: true });

process.stdout.write(`Built ${outputPath}\n`);
