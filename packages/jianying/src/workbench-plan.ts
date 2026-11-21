import { randomSplitPlan, secureRandom } from "./plan.js";
import { DEFAULT_WORKBENCH_RANGES, validateWorkbenchRanges, type WorkbenchRanges } from "./workbench-settings.js";

/** A few base cuts, copied video overlays, and intentionally overlapping audio. */
export function firstEpisodeWorkbench(duration: number, sample = secureRandom, settings: WorkbenchRanges = DEFAULT_WORKBENCH_RANGES) {
  const ranges = validateWorkbenchRanges(settings);
  const draw = () => { const value=sample(); if (!Number.isFinite(value) || value<0 || value>=1) throw new Error("随机数无效"); return value; };
  const integer = (min: number,max: number) => min+Math.floor(draw()*(max-min+1));
  const base = duration < 2 ? randomSplitPlan(duration,0.5,2,sample)
    : randomSplitPlan(duration,Math.max(0.5,Math.min(2,duration/20),duration/100),Math.max(0.5,duration*0.4),sample);
  const videoCount = integer(ranges.videoBlocksMin,ranges.videoBlocksMax);
  const audioCount = integer(ranges.audioBlocksMin,ranges.audioBlocksMax);
  const totalFrames = Math.max(1,Math.round(duration*30));
  const originalCountMax = Math.max(1,Math.min(8,audioCount-1,Math.floor(totalFrames/15)));
  const originalCount = integer(Math.min(4,originalCountMax),originalCountMax);
  // Stratified, shuffled weights retain pronounced short/long variation even
  // when the random source returns similar successive values.
  const partition = (total: number, count: number, maximum = total) => {
    const minimum = Math.max(1,Math.floor(total/count*0.12));
    const cap = Math.max(Math.ceil(total/count),maximum);
    const weights = Array.from({length:count},(_,index)=>0.08+((index+draw())/count)**2*2.4);
    for (let index=count-1;index>0;index--) {
      const other=integer(0,index); [weights[index],weights[other]]=[weights[other],weights[index]];
    }
    const lengths=Array(count).fill(minimum) as number[];
    let remaining=total-count*minimum;
    const shortIndex=weights.indexOf(Math.min(...weights));
    const reserveShort=count>=3 && (count-1)*cap+minimum>=total;
    while (remaining>0) {
      const available=lengths.map((length,index)=>({index,room:cap-length})).filter(item=>item.room>0 && (!reserveShort || item.index!==shortIndex));
      const sum=available.reduce((value,item)=>value+weights[item.index],0);
      let allocated=0;
      for (const item of available) {
        const amount=Math.min(item.room,remaining-allocated,Math.max(1,Math.floor(remaining*weights[item.index]/sum)));
        lengths[item.index]+=amount; allocated+=amount;
        if (allocated===remaining) break;
      }
      remaining-=allocated;
    }
    return lengths;
  };
  let usedFrames=0;
  const audio = partition(totalFrames,originalCount,Math.ceil(totalFrames*0.55)).map((frames,index)=>{
    const clip={index:index+1,start:usedFrames/30,duration:frames/30}; usedFrames+=frames;return clip;
  });
  const overlays: Array<{ sourceIndex: number; track: number; seconds: number; duration: number }> = [];
  const perTrack=[Math.ceil(videoCount/2),Math.floor(videoCount/2)];
  const longestBase=Math.max(...base.map(clip=>Math.round(clip.duration*30)));
  const grids=perTrack.map(count=>{
    let start=0;
    return partition(totalFrames,count,Math.floor(longestBase/0.8)).map(frames=>{
      const cell={start,frames};start+=frames;return cell;
    });
  });
  for (let index=0;index<perTrack[0];index++) for (const track of [1,2]) {
    const cell=grids[track-1][index];if (!cell) continue;
    const target=Math.max(1,Math.floor(cell.frames*(0.86+draw()*0.10)));
    const candidates=base.map((clip,sourceIndex)=>({clip,sourceIndex})).filter(({clip})=>Math.round(clip.duration*30)>=target);
    const sourceIndex=candidates.length ? candidates[integer(0,candidates.length-1)].sourceIndex
      : base.reduce((best,clip,index)=>clip.duration>base[best].duration?index:best,0);
    const frames=Math.min(target,Math.round(base[sourceIndex].duration*30));
    const start=cell.start+integer(0,Math.max(0,cell.frames-frames));
    overlays.push({sourceIndex,track,seconds:start/30,duration:frames/30});
  }
  // Every pasted audio block gets its own trim, rather than repeating one
  // of the handful of original lengths unchanged.
  const audioCopies: Array<{sourceIndex:number;seconds:number;duration:number}>=[];
  const copyCount=audioCount-audio.length;
  const cells=partition(totalFrames,copyCount,Math.floor(450/0.88));
  let cursor=0, previousEnd=0;
  for (let index=0;index<copyCount;index++) {
    const cell=cells[index];
    const target=Math.min(450,Math.max(1,Math.floor(cell*(0.88+draw()*0.10))));
    const candidates=audio.map((clip,sourceIndex)=>({clip,sourceIndex})).filter(({clip})=>Math.round(clip.duration*30)>=target);
    const sourceIndex=candidates.length ? candidates[integer(0,candidates.length-1)].sourceIndex
      : audio.reduce((best,clip,index)=>clip.duration>audio[best].duration?index:best,0);
    const frames=Math.min(target,Math.round(audio[sourceIndex].duration*30));
    let start=cursor+integer(0,Math.min(6,Math.max(0,cell-frames)));
    // Occasional small overlaps create a staggered extra row without long holes.
    if (index>0 && draw()<0.35 && previousEnd>=cursor-9) start=Math.max(0,previousEnd-integer(1,9));
    start=Math.min(start,totalFrames-frames);
    audioCopies.push({sourceIndex,seconds:start/30,duration:frames/30});
    cursor+=cell;previousEnd=start+frames;
  }
  return {base,audio,overlays,audioCopies,ranges,screenshotCount:4,zoomSteps:2,sourceMode:"first-episode" as const};
}
