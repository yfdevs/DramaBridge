/** Called only after manifest consistency checks and cooldown filtering. */
export function preferredUpdateSource<T extends { source: { id: string } }>(results: T[]): T | undefined {
  for (const id of ["gh-proxy-v4", "gh-proxy-v6", "github"]) {
    const found = results.find(result => result.source.id === id);
    if (found) return found;
  }
  return undefined;
}
