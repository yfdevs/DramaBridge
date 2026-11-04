/** Shared by cloud transfer and download scans; serialized into the share page. */
export function matchBaiduEpisodeIndex(filename: string): number | undefined {
  const stem = String(filename || '').replace(/\.[^.]+$/, '').trim();
  const match = stem.match(/第\s*(\d+)\s*集/)
    ?? stem.match(/^(?:ep|episode|e)[\s._-]*(\d+)$/i)
    ?? stem.match(/[（(]\s*(\d{1,4})\s*[）)]\s*$/)
    ?? stem.match(/^(\d{1,4})\s*[·•・、，,。．._—–-]\s*\S/u)
    ?? stem.match(/(\d{1,4})\s*(?:集|episode|ep|e)?\s*$/i);
  const index = Number(match?.[1]);
  return Number.isInteger(index) && index > 0 ? index : undefined;
}
