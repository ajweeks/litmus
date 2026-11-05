// Keep source quotes verbatim. Models paraphrase or stitch together "quotes", so a quote is only
// kept if it can be found in text the page really contains: first the cited_text the web search
// API attaches to its citations (verbatim by construction), then the live page. Whatever is shown
// is the page's own wording, not the model's.

import { isHttpUrl, withTextFragment } from "./links";
import { LIMITS } from "./config";
import { safeFetchBytes, safeFetchText } from "./safeFetch";
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

/** A page's text: one string per PDF page, or a single string for HTML and plain text. */
interface PageText {
  pages: string[];
  pdf: boolean;
}

/** PDF text per page, with words hyphenated across line breaks joined again ("yr-\nkesexamen"). */
async function pdfPages(bytes: Uint8Array): Promise<string[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(bytes);
  const { text } = await extractText(doc, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).map((t) => t.replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2"));
}

const pageCache = new Map<string, PageText | null>();

/** The page's text, or null if it can't be read. Only public http(s) hosts are fetched (lib/safeFetch.ts). */
async function fetchPageText(url: string): Promise<PageText | null> {
  if (pageCache.has(url)) return pageCache.get(url)!;
  let out: PageText | null = null;
  try {
    const headers = { "User-Agent": "Mozilla/5.0 (compatible; litmus/0.1; quote verification)" };
    if (/\.pdf($|[?#])/i.test(url)) {
      const res = await safeFetchBytes(url, { headers, maxBytes: LIMITS.pdfBytes, timeoutMs: 20000 });
      if (res.status >= 200 && res.status < 300 && !res.truncated && /pdf|octet-stream/.test(res.contentType)) out = { pages: await pdfPages(res.bytes), pdf: true };
    } else {
      const res = await safeFetchText(url, { headers });
      if (res.status >= 200 && res.status < 300) {
        if (/text\/html|text\/plain/.test(res.contentType)) out = { pages: [htmlToText(res.text)], pdf: false };
        else if (/application\/pdf/.test(res.contentType)) {
          const bytes = await safeFetchBytes(url, { headers, maxBytes: LIMITS.pdfBytes, timeoutMs: 20000 });
          if (!bytes.truncated) out = { pages: await pdfPages(bytes.bytes), pdf: true };
        }
      }
    }
  } catch {
    out = null;
  }
  if (pageCache.size > 50) pageCache.delete(pageCache.keys().next().value!);
  pageCache.set(url, out);
  return out;
}

/** The exact span of `haystack` that matches `quote` (ignoring case, whitespace and markup characters). */
function findVerbatim(haystack: string, quote: string): string | null {
  const at = locate(haystack, quote);
  return at ? haystack.slice(at[0], at[1]).trim() : null;
}

export interface VerifiedQuote {
  /** Page wording: the model's quote as found on the page, or the search API's own snippet, or "". */
  quote: string;
  /** True only when the model's quote itself was found on the page (not a fallback snippet). */
  verified: boolean;
  /** For a PDF: the 1-based page the quote is on. */
  page: number | null;
}

/**
 * Check `quote` against `url`. Only call this for URLs that came back from the web search
 * (never arbitrary model output), since it fetches the page.
 */
export async function verifyQuote(url: string, quote: string, citedTexts: string[]): Promise<VerifiedQuote> {
  const q = quote.trim();
  if (q) {
    for (const cited of citedTexts) {
      const hit = findVerbatim(cited, q);
      if (hit) {
        // The snippet proves the wording; for a PDF, still find the page so the link can open it.
        const page = /\.pdf($|[?#])/i.test(url) ? await pageOf(url, hit) : null;
        return { quote: hit, verified: true, page };
      }
    }
    const text = await fetchPageText(url);
    if (text)
      for (let i = 0; i < text.pages.length; i++) {
        const hit = findVerbatim(text.pages[i], q);
        if (hit) return { quote: hit, verified: true, page: text.pdf ? i + 1 : null };
      }
  }
  // The model's quote didn't check out; fall back to what the search API itself quoted from this
  // page. That is the page's wording but not necessarily about the claim, so it is not "verified".
  return { quote: citedTexts[0]?.trim() ?? "", verified: false, page: null };
}

async function pageOf(url: string, quote: string): Promise<number | null> {
  const text = await fetchPageText(url);
  if (!text?.pdf) return null;
  const i = text.pages.findIndex((p) => !!findVerbatim(p, quote));
  return i < 0 ? null : i + 1;
}

/** The verbatim quote only (see verifyQuote). */
export async function verbatimQuote(url: string, quote: string, citedTexts: string[]): Promise<string> {
  return (await verifyQuote(url, quote, citedTexts)).quote;
}
