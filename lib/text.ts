// Fuzzy text location shared by the server (char offsets) and the browser (highlighting).

const SMART = /[‘’‚‛′]/g;
const SMART_D = /[“”„‟″]/g;
const DASHES = /[‐-―−]/g;

/** Characters that markdown adds or that differ cosmetically between raw and rendered text. */
const IGNORED = /[*_`#>\[\]]/;

/**
 * Normalise text for matching and keep a map from each normalised character back to its
 * index in the original string.
 */
export function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i];
    if (IGNORED.test(ch)) continue;
    ch = ch.replace(SMART, "'").replace(SMART_D, '"').replace(DASHES, "-");
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      ch = " ";
      lastSpace = true;
    } else {
      lastSpace = false;
    }
    norm += ch.toLowerCase();
    map.push(i);
  }
  return { norm, map };
}

export function normalize(text: string): string {
  return normalizeWithMap(text).norm.trim();
}

/** Find `quote` in `text`, ignoring markdown, case and whitespace. Returns [start, end) in `text`, or null. */
export function locate(text: string, quote: string, from = 0): [number, number] | null {
  const q = normalize(quote);
  if (!q) return null;
  const { norm, map } = normalizeWithMap(text);
  const startNorm = map.findIndex((orig) => orig >= from);
  const idx = norm.indexOf(q, Math.max(0, startNorm));
  if (idx < 0) return null;
  return [map[idx], map[idx + q.length - 1] + 1];
}
