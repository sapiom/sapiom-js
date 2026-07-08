/**
 * Minimal subsequence fuzzy matcher for the command palette — not a library,
 * just enough to rank "characters of the query appear in order in the
 * target" matches, favoring contiguous runs and matches near the start.
 * Returns null when the query isn't a subsequence of the target at all.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let score = 0;
  let targetIndex = 0;
  let consecutiveRun = 0;

  for (let i = 0; i < q.length; i++) {
    const char = q[i];
    const foundAt = t.indexOf(char, targetIndex);
    if (foundAt === -1) return null;

    consecutiveRun = foundAt === targetIndex ? consecutiveRun + 1 : 0;
    score += 10 - Math.min(foundAt - targetIndex, 8); // reward proximity to the previous match
    score += consecutiveRun * 3; // reward contiguous runs
    if (foundAt === 0) score += 5; // reward matching right at the start

    targetIndex = foundAt + 1;
  }

  return score;
}
