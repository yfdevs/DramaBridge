import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { KuaishouRecreationRepository } from "../../electron/storage/kuaishou-recreation";

test("recreation imports atomically and recovers interrupted versions without losing shares", () => {
  const db = new Database(":memory:");
  try {
    const repo = new KuaishouRecreationRepository(db);
    const input = {
      originalTitle: "原剧",
      episodeCount: 101,
      shareText: "https://pan.baidu.com/s/1test",
      versions: ["新剧"],
    };
    repo.import([input]);
    const task = repo.list()[0];
    assert.equal(repo.nextQueued()?.id, task.id);
    assert.equal(task.downloadCount, 61);
    assert.deepEqual(
      task.results.map((item) => item.title),
      ["原剧", "新剧"],
    );
    assert.throws(() => repo.import([{ ...input, originalTitle: "另一剧" }, input]), /重复/);
    assert.equal(repo.list().length, 1);
    task.state = "uploading";
    task.results[0].shareUrl = "https://pan.baidu.com/s/1done";
    task.results[0].extractionCode = "abcd";
    task.sourcePath = "D:/素材/原剧/素材";
    task.results[1].localPath = "D:/素材/原剧/版本/新剧-60%";
    task.results[1].localFiles = [{ path: "成片/新剧-第1集.mp4", size: 100, modifiedAtMs: 123 }];
    task.results[1].verifiedFiles = [{ path: "/新剧/第1集.mp4", fsId: "1", size: 100, serverMd5: "wrong", serverMtime: 100, contentMd5: "verified" }];
    repo.save(task);
    assert.equal(repo.nextQueued(), undefined);
    const reopened = new KuaishouRecreationRepository(db);
    assert.equal(reopened.list()[0].state, "interrupted");
    assert.equal(reopened.list()[0].results[0].shareUrl, "https://pan.baidu.com/s/1done");
    assert.equal(reopened.list()[0].sourcePath, task.sourcePath);
    assert.deepEqual(reopened.list()[0].results[1].localFiles, task.results[1].localFiles);
    assert.deepEqual(reopened.list()[0].results[1].verifiedFiles, task.results[1].verifiedFiles);
  } finally {
    db.close();
  }
});
