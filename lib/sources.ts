// Keep source quotes verbatim. Models paraphrase or stitch together "quotes", so a quote is only
// kept if it can be found in text the page really contains: first the cited_text the web search
// API attaches to its citations (verbatim by construction), then the live page. Whatever is shown
// is the page's own wording, not the model's.

import { isHttpUrl, withTextFragment } from "./links";
import { safeFetchText } from "./safeFetch";
import { locate } from "./text";

export { isHttpUrl, withTextFragment };

/** Minimal HTML → text: drop scripts/styles/markup, decode common entities, keep word boundaries. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, "-")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t\r\f\v]+/g, " ");
}

/** The page's text, or null if it can't be read. Only public http(s) hosts are fetched (lib/safeFetch.ts). */
async function fetchPageText(url: string): Promise<string | null> {
  try {
    const res = await safeFetchText(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; litmus/0.1; quote verification)" },
    });
    if (res.status < 200 || res.status >= 300 || !/text\/html|text\/plain/.test(res.contentType)) return null;
    return htmlToText(res.text);
  } catch {
    return null;
  }
}

/** The exact span of `haystack` that matches `quote` (ignoring case, whitespace and markup characters). */
function findVerbatim(haystack: string, quote: string): string | null {
  const at = locate(haystack, quote);
  return at ? haystack.slice(at[0], at[1]).trim() : null;
}

/**
 * Return a verbatim version of `quote` from `url`, or "" if it can't be confirmed.
 * Only call this for URLs that came back from the web search (never arbitrary model output),
 * since it fetches the page.
 */
export async function verbatimQuote(url: string, quote: string, citedTexts: string[]): Promise<string> {
  const q = quote.trim();
  if (q) {
    for (const cited of citedTexts) {
      const hit = findVerbatim(cited, q);
      if (hit) return hit;
    }
    const page = await fetchPageText(url);
    const hit = page ? findVerbatim(page, q) : null;
    if (hit) return hit;
  }
  // The model's quote didn't check out; fall back to what the search API itself quoted from this page.
  return citedTexts[0]?.trim() ?? "";
}
