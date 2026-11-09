import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendDouyinRelationshipProof } from "../../src/shared/relationship-proof.js";
import { douyinRelationshipProofBase64 } from "../../src/shared/relationship-proof-image.js";

test("keeps 明星说 ownership files unchanged and appends the fixed certificate for every other account", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "douyin-relationship-proof-"));
  const originals = ["original-authorization.png", "original-contract.pdf"];
  try {
    assert.deepEqual(await appendDouyinRelationshipProof(originals, { douyinAccountId: "17732354154" }, directory), originals);
    for (const accountId of ["19030631294", "15690428001", "future-account"]) {
      const files = await appendDouyinRelationshipProof(originals, { douyinAccountId: accountId }, directory);
      assert.deepEqual(files.slice(0, -1), originals);
      assert.equal(files.length, originals.length + 1);
      const image = await readFile(files.at(-1)!);
      assert.equal(image.toString("base64"), douyinRelationshipProofBase64);
      assert.deepEqual(await appendDouyinRelationshipProof(files, { douyinAccountId: accountId }, directory), files);
    }
    assert.deepEqual(originals, ["original-authorization.png", "original-contract.pdf"]);
    await assert.rejects(appendDouyinRelationshipProof(originals, {}, directory), /ACCOUNT_ID_REQUIRED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
