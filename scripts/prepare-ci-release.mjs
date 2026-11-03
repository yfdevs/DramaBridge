import { execFileSync } from "node:child_process";
import console from "node:console";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import semver from "semver";

// Include existing release tags so a locally published version is never reused.
const manifestPath = new URL("../package.json", import.meta.url);
const original = await readFile(manifestPath, "utf8");
const { version } = JSON.parse(original);
if (!semver.valid(version)) throw new Error(`Invalid package version: ${version}`);
const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" });
const versions = [version, ...tags.split(/\r?\n/).map((tag) => tag.replace(/^v/, ""))]
  .filter((value) => semver.valid(value) && !semver.prerelease(value));
const nextVersion = semver.inc(semver.rsort(versions)[0], "patch");
if (process.argv.includes("--dry-run")) {
  console.log(`Next release version: ${nextVersion}`);
  process.exit(0);
}
await writeFile(manifestPath, original.replace(
  /("version"\s*:\s*")[^"]*(")/u,
  (_match, prefix, suffix) => `${prefix}${nextVersion}${suffix}`,
));
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `version=${nextVersion}\ntag=v${nextVersion}\n`);
}
console.log(`Release version: ${version} -> ${nextVersion}`);
