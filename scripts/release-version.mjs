import console from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import semver from "semver";

export async function withReleaseVersion(packageJsonPath, release) {
  const original = await readFile(packageJsonPath, "utf8");
  const { version } = JSON.parse(original);
  const nextVersion = typeof version === "string" ? semver.inc(version, "patch") : null;
  if (!nextVersion) throw new Error(`Invalid release version: ${version}`);

  // Preserve the manifest's formatting and all existing local edits.
  const updated = original.replace(
    /("version"\s*:\s*")[^"]*(")/u,
    (_match, prefix, suffix) => `${prefix}${nextVersion}${suffix}`,
  );
  try {
    await writeFile(packageJsonPath, updated, "utf8");
    console.log(`Release version: ${version} -> ${nextVersion}`);
    await release(nextVersion);
  } catch (error) {
    try {
      await writeFile(packageJsonPath, original, "utf8");
      console.error(`Release failed; restored version ${version}.`);
    } catch (rollbackError) {
      const failure = new AggregateError(
        [error, rollbackError],
        `Release failed and version rollback failed; restore package.json to ${version} manually.`,
        { cause: rollbackError },
      );
      throw failure;
    }
    throw error;
  }
}
