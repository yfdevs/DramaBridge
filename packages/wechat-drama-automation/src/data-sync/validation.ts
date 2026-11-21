/** A changed total must never turn a truncated response into a successful run. */
export function assertCompleteStatistics(
  fetchedCount: number,
  initialTotal: number,
  responseTotal: number,
) {
  if (
    ![fetchedCount, initialTotal, responseTotal].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    fetchedCount !== responseTotal ||
    fetchedCount < initialTotal
  ) {
    throw new Error(
      `视频号完整剧集统计数据不完整：首次总数 ${initialTotal}，当前总数 ${responseTotal}，实际获取 ${fetchedCount} 条`,
    );
  }
}
