// Link helpers shared by the browser and the server. Kept free of Node imports so the UI can use them.

/** A link the UI may put in an href: only web URLs, never javascript: or data: schemes. */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Link that scrolls to and highlights `quote` on the page (a URL text fragment). */
export function withTextFragment(url: string, quote: string): string {
  // A URL that isn't a web address never becomes a link target.
  if (!isHttpUrl(url)) return "#";
  const words = quote.replace(/\s+/g, " ").trim().split(" ");
  if (!quote.trim() || /:~:text=/.test(url)) return url;
  // Text fragments must match exactly, so long quotes use "start,end" with a few words from each end.
  // These characters have meaning inside the directive and must be percent-encoded.
  const enc = (s: string) => encodeURIComponent(s).replace(/-/g, "%2D").replace(/,/g, "%2C").replace(/&/g, "%26");
  const directive =
    words.length > 10 ? `${enc(words.slice(0, 4).join(" "))},${enc(words.slice(-4).join(" "))}` : enc(words.join(" "));
  return `${url}${url.includes("#") ? "" : "#"}:~:text=${directive}`;
}
