import assert from "node:assert/strict";
import { test } from "node:test";
import { firstEpisodeWorkbench } from "../src/workbench-plan.js";

function seeded(seed: number) { return () => { seed = (1664525*seed+1013904223)>>>0; return seed/2**32; }; }
test("first episode keeps a few unequal base cuts and scattered short and long overlay copies", () => {
  const duration = 103.4;
  const plan = firstEpisodeWorkbench(duration,seeded(42));
  assert.ok(plan.base.length>=3 && plan.base.length<=6);
  assert.ok(new Set(plan.base.map(c=>c.duration)).size>1);
  assert.ok(Math.abs(plan.base.reduce((sum,c)=>sum+c.duration,0)-duration)<1/30);
  assert.ok(plan.overlays.length>=8 && plan.overlays.length<=14);
  assert.ok(plan.audio.length+plan.audioCopies.length>=20 && plan.audio.length+plan.audioCopies.length<=40);
  for (const track of [1,2]) {
    const copies = plan.overlays.filter(c=>c.track===track).sort((a,b)=>a.seconds-b.seconds);
    assert.ok(copies[0].seconds<duration/3);
    assert.ok(copies.at(-1)!.seconds+copies.at(-1)!.duration>duration*0.9);
    for (const [index,copy] of copies.entries()) {
      assert.ok(copy.duration<=plan.base[copy.sourceIndex].duration);
      assert.ok(copy.seconds>=0 && copy.seconds+copy.duration<=duration);
      if (index) assert.ok(copy.seconds>=copies[index-1].seconds+copies[index-1].duration);
    }
  }
  assert.ok(new Set(plan.overlays.map(c=>c.duration)).size>1);
  for (const copy of plan.audioCopies) assert.ok(copy.seconds+copy.duration<=duration);
  assert.equal(plan.screenshotCount,4);
  assert.equal(plan.sourceMode,"first-episode");
});
test("configured ranges choose inclusive counts and vary across runs", () => {
  const ranges = {videoBlocksMin:13,videoBlocksMax:21,audioBlocksMin:25,audioBlocksMax:37};
  const videos = new Set<number>(), audios = new Set<number>();
  for (let seed=1;seed<=100;seed++) {
    const plan = firstEpisodeWorkbench(103.4,seeded(seed),ranges);
    videos.add(plan.overlays.length); audios.add(plan.audio.length+plan.audioCopies.length);
    assert.ok(plan.overlays.length>=13 && plan.overlays.length<=21);
    assert.ok(plan.audio.length+plan.audioCopies.length>=25 && plan.audio.length+plan.audioCopies.length<=37);
    assert.ok(Math.abs(plan.audio.reduce((sum,c)=>sum+c.duration,0)-103.4)<1/30);
  }
  assert.ok(videos.size>3); assert.ok(audios.size>3);
  const low = firstEpisodeWorkbench(103.4,()=>0,ranges);
  const high = firstEpisodeWorkbench(103.4,()=>0.999999,ranges);
  assert.equal(low.overlays.length,13); assert.equal(high.overlays.length,21);
  assert.equal(low.audio.length+low.audioCopies.length,25); assert.equal(high.audio.length+high.audioCopies.length,37);
});
test("invalid count ranges fail before editing or encoding", () => {
  assert.throws(()=>firstEpisodeWorkbench(103.4,seeded(1),{videoBlocksMin:24,videoBlocksMax:12,audioBlocksMin:20,audioBlocksMax:40}),/最少数量/);
  assert.throws(()=>firstEpisodeWorkbench(103.4,seeded(1),{videoBlocksMin:12.5,videoBlocksMax:24,audioBlocksMin:20,audioBlocksMax:40}),/整数/);
});
test("new randomness changes cuts, overlays, and repeated audio placements", () => {
  const a = firstEpisodeWorkbench(103.4,seeded(1));
  const b = firstEpisodeWorkbench(103.4,seeded(2));
  assert.notDeepEqual(a.base,b.base);
  assert.notDeepEqual(a.overlays,b.overlays);
  assert.notDeepEqual(a.audioCopies,b.audioCopies);
});

test("dense layouts fill both video rows and pack audio without long interior gaps", () => {
  for (let seed=1;seed<=100;seed++) {
    const plan = firstEpisodeWorkbench(103.4,seeded(seed));
    for (const track of [1,2]) {
      const coverage = plan.overlays.filter(c=>c.track===track).reduce((sum,c)=>sum+c.duration,0)/103.4;
      assert.ok(coverage>0.70, `seed ${seed}: video coverage ${coverage}`);
    }
    for (let index=1;index<plan.audioCopies.length;index++) {
      const previous = plan.audioCopies[index-1];
      const current = plan.audioCopies[index];
      if (current.seconds<previous.seconds) continue; // next packed layer
      const gap = current.seconds-previous.seconds-previous.duration;
      assert.ok(gap>=-0.31 && gap<=3);
    }
  }
});


test("dense rows contain visibly short and long clips rather than near-uniform cells", () => {
  for (let seed=1;seed<=100;seed++) {
    const plan=firstEpisodeWorkbench(103.4,seeded(seed));
    for (const track of [1,2]) {
      const lengths=plan.overlays.filter(copy=>copy.track===track).map(copy=>copy.duration);
      assert.ok(Math.max(...lengths)/Math.min(...lengths)>2.5,`seed ${seed}: video variation`);
    }
    const lengths=plan.audioCopies.map(copy=>copy.duration);
    assert.ok(plan.audioCopies.at(-1)!.seconds+plan.audioCopies.at(-1)!.duration>103.4*0.9);
    assert.ok(lengths.reduce((sum,value)=>sum+value,0)>103.4*0.75);
    assert.ok(new Set(lengths).size>=Math.min(6,lengths.length),`seed ${seed}: audio variation`);
    for (const copy of plan.audioCopies) {
      assert.ok(copy.duration<=plan.audio[copy.sourceIndex].duration+1e-9);
      assert.ok(copy.duration<=15);
      assert.ok(copy.seconds+copy.duration<=103.4+1e-9);
      assert.ok(Math.abs(copy.duration*30-Math.round(copy.duration*30))<1e-8);
    }
  }
});
