/**
 * Boundary-gated fuzzy matcher for the command palette.
 *
 * The old matcher accepted any in-order subsequence, so a short query would
 * "match" characters scattered across a long absolute path ("slack" inside
 * /Users/…/hackathon-local/workflows/backlog-nudge) and flood the palette
 * with noise. This one only accepts a match when every matched character is
 * contiguous with the previous one OR sits at a word/segment boundary
 * (start, after a separator, digit transition, camelCase hump), plus a
 * plain-substring pass so mid-word fragments ("otif" → slack-noTIFier)
 * still land. Scattered subsequences are rejected outright — not merely
 * down-ranked.
 *
 * Multi-term: the query splits on whitespace and every term must match the
 * target independently (AND); the score is the sum, the highlight indices
 * the union.
 */

export interface FuzzyMatch {
  score: number;
  /** Target indices the query characters landed on — the highlight spans. */
  indices: number[];
}

const CHAR_BASE = 1; // every matched character
const BONUS_BOUNDARY = 12; // character matched at a word/segment boundary
const BONUS_CONSECUTIVE = 10; // character adjacent to the previous match
const BONUS_START = 20; // term starts at the very beginning of the target
const BONUS_EXACT = 25; // the whole query IS the whole target

/** Skipping characters costs, so tighter placements win; capped because a
 *  20-char gap is not meaningfully worse than a 10-char one. */
const gapPenalty = (gap: number): number => -(3 + Math.min(gap, 9));

const SEPARATORS = new Set(["/", "\\", "-", "_", ".", ":", " "]);
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isLower = (ch: string): boolean => ch !== ch.toUpperCase() && ch === ch.toLowerCase();
const isUpper = (ch: string): boolean => ch !== ch.toLowerCase() && ch === ch.toUpperCase();

/** Word/segment starts, computed on the ORIGINAL casing (matching itself is
 *  case-insensitive, but the camelCase hump only exists pre-lowering). */
function computeBoundaries(target: string): boolean[] {
  const out = new Array<boolean>(target.length);
  for (let j = 0; j < target.length; j++) {
    if (j === 0) {
      out[j] = true;
      continue;
    }
    const prev = target[j - 1];
    const cur = target[j];
    out[j] =
      SEPARATORS.has(prev) ||
      isDigit(cur) !== isDigit(prev) ||
      (isUpper(cur) && isLower(prev));
  }
  return out;
}

interface TermMatch {
  score: number;
  indices: number[];
}

/** Gated-subsequence pass: first char at a boundary, every next char at
 *  prev+1 or a later boundary. Memoized best-score search over the small
 *  (term × target) state space; `next` pointers reconstruct the indices. */
function gatedPass(
  term: string,
  targetLower: string,
  boundaries: boolean[],
  boundaryPos: ReadonlyMap<string, number[]>,
): TermMatch | null {
  const n = term.length;
  const m = targetLower.length;

  const stepScore = (p: number, p2: number): number => {
    let s = CHAR_BASE;
    if (boundaries[p2]) s += BONUS_BOUNDARY;
    if (p2 === p + 1) s += BONUS_CONSECUTIVE;
    const gap = p2 - p - 1;
    if (gap >= 1) s += gapPenalty(gap);
    return s;
  };

  // memo[(i, p)] = best score matching term[i+1..] given term[i] sits at p,
  // with the chosen position for term[i+1] (-1 = dead end / last char).
  const memo = new Map<number, { score: number; next: number }>();
  const g = (i: number, p: number): number => {
    if (i === n - 1) return 0;
    const key = i * m + p;
    const hit = memo.get(key);
    if (hit !== undefined) return hit.score;
    const want = term[i + 1];
    let best = Number.NEGATIVE_INFINITY;
    let bestNext = -1;
    if (p + 1 < m && targetLower[p + 1] === want) {
      const s = stepScore(p, p + 1) + g(i + 1, p + 1);
      if (s > best) {
        best = s;
        bestNext = p + 1;
      }
    }
    for (const b of boundaryPos.get(want) ?? []) {
      if (b <= p + 1) continue; // p+1 already tried; earlier positions illegal
      const s = stepScore(p, b) + g(i + 1, b);
      if (s > best) {
        best = s;
        bestNext = b;
      }
    }
    memo.set(key, { score: best, next: bestNext });
    return best;
  };

  let bestTotal = Number.NEGATIVE_INFINITY;
  let bestStart = -1;
  for (const p0 of boundaryPos.get(term[0]) ?? []) {
    const startScore = CHAR_BASE + BONUS_BOUNDARY + (p0 === 0 ? BONUS_START : 0);
    const total = startScore + g(0, p0);
    if (total > bestTotal) {
      bestTotal = total;
      bestStart = p0;
    }
  }
  if (bestStart === -1 || !Number.isFinite(bestTotal)) return null;

  const indices = [bestStart];
  for (let i = 0, p = bestStart; i < n - 1; i++) {
    const next = memo.get(i * m + p)?.next ?? -1;
    indices.push(next);
    p = next;
  }
  return { score: bestTotal, indices };
}

/** Substring pass: the term occurs contiguously anywhere — the only way a
 *  match may START off-boundary. Best occurrence wins (a boundary-aligned
 *  one outscores a mid-word one). */
function substringPass(term: string, targetLower: string, boundaries: boolean[]): TermMatch | null {
  let best: { score: number; start: number } | null = null;
  for (let from = 0; ; ) {
    const at = targetLower.indexOf(term, from);
    if (at === -1) break;
    let s = at === 0 ? BONUS_START : 0;
    for (let k = 0; k < term.length; k++) {
      s += CHAR_BASE;
      if (boundaries[at + k]) s += BONUS_BOUNDARY;
      if (k > 0) s += BONUS_CONSECUTIVE;
    }
    if (best === null || s > best.score) best = { score: s, start: at };
    from = at + 1;
  }
  if (best === null) return null;
  const start = best.start;
  return { score: best.score, indices: Array.from({ length: term.length }, (_, k) => start + k) };
}

/** Full match info (score + matched character positions) — the palette
 *  bolds the matched characters, so it needs the indices, not just a rank. */
/** Per-code-unit lowering that PRESERVES LENGTH: a character whose lowercase
 *  expands (e.g. İ → i̇) stays as-is, so match indices computed against the
 *  lowered string always line up with the original for highlighting. */
function lowerAligned(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const lower = s[i].toLowerCase();
    out += lower.length === 1 ? lower : s[i];
  }
  return out;
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  // Dedupe repeated terms: "slack slack" must not score a single occurrence
  // twice against targets that contain it once.
  const terms = [...new Set(lowerAligned(query).split(/\s+/).filter(Boolean))];
  if (terms.length === 0) return { score: 0, indices: [] };
  if (!target) return null;

  const targetLower = lowerAligned(target);
  const boundaries = computeBoundaries(target);
  const boundaryPos = new Map<string, number[]>();
  for (let j = 0; j < target.length; j++) {
    if (!boundaries[j]) continue;
    const ch = targetLower[j];
    const list = boundaryPos.get(ch);
    if (list) list.push(j);
    else boundaryPos.set(ch, [j]);
  }

  let score = 0;
  const indexSet = new Set<number>();
  for (const term of terms) {
    if (term.length > targetLower.length) return null;
    const gated = gatedPass(term, targetLower, boundaries, boundaryPos);
    const substr = substringPass(term, targetLower, boundaries);
    const match = gated && substr ? (gated.score >= substr.score ? gated : substr) : (gated ?? substr);
    if (!match) return null;
    score += match.score;
    for (const idx of match.indices) indexSet.add(idx);
  }
  if (lowerAligned(query.trim()) === targetLower) score += BONUS_EXACT;

  return { score, indices: [...indexSet].sort((a, b) => a - b) };
}

export function fuzzyScore(query: string, target: string): number | null {
  return fuzzyMatch(query, target)?.score ?? null;
}
