// Forgiving text search: every query word must appear somewhere, in any order, ignoring case,
// accents and punctuation, and allowing a typo or two in longer words.

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const words = (s: string) => normalize(s).split(" ").filter(Boolean);

/** Levenshtein distance, giving up once it exceeds `max`. */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/** Typos allowed for a query word of this length: none for short words, then one, then two. */
const tolerance = (n: number) => (n < 4 ? 0 : n < 8 ? 1 : 2);

function wordMatches(q: string, text: string, textWords: string[]): boolean {
  if (text.includes(q)) return true;
  const max = tolerance(q.length);
  // Compare against whole words and against same-length prefixes, so "photosynth" finds "photosynthesis".
  return max > 0 && textWords.some((w) => within(q, w, max) || (w.length > q.length && within(q, w.slice(0, q.length), max)));
}

/** A matcher for `query`; the empty query matches everything. */
export function fuzzyMatcher(query: string): (...fields: (string | null | undefined)[]) => boolean {
  const qs = words(query);
  if (!qs.length) return () => true;
  return (...fields) => {
    const text = normalize(fields.filter(Boolean).join(" "));
    const textWords = text.split(" ");
    return qs.every((q) => wordMatches(q, text, textWords));
  };
}
