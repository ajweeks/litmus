// Keep source quotes verbatim. Models paraphrase or stitch together "quotes", so a quote is only
// kept if it can be found in text the page really contains: first the cited_text the web search
// API attaches to its citations (verbatim by construction), then the live page. Whatever is shown
// is the page's own wording, not the model's.

import { locate } from "./text";

const MAX_PAGE_BYTES = 3_000_000;

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

async function fetchPageText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; fact-check/0.1; quote verification)" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok || !/text\/html|text\/plain/.test(res.headers.get("content-type") ?? "")) return null;
    const html = (await res.text()).slice(0, MAX_PAGE_BYTES);
    return htmlToText(html);
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

/** Link that scrolls to and highlights `quote` on the page (a URL text fragment). */
export function withTextFragment(url: string, quote: string): string {
  const words = quote.replace(/\s+/g, " ").trim().split(" ");
  if (!quote.trim() || /:~:text=/.test(url)) return url;
  // Text fragments must match exactly, so long quotes use "start,end" with a few words from each end.
  // These characters have meaning inside the directive and must be percent-encoded.
  const enc = (s: string) => encodeURIComponent(s).replace(/-/g, "%2D").replace(/,/g, "%2C").replace(/&/g, "%26");
  const directive =
    words.length > 10 ? `${enc(words.slice(0, 4).join(" "))},${enc(words.slice(-4).join(" "))}` : enc(words.join(" "));
  return `${url}${url.includes("#") ? "" : "#"}:~:text=${directive}`;
}
