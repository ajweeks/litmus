// Minimal server-sent-events reader for the providers called with plain fetch.

/** Yield each event's parsed JSON `data:` payload until the stream ends or sends [DONE]. */
export async function* readSse<T = unknown>(res: Response): AsyncGenerator<T> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: RegExpMatchArray | null;
    // Events are separated by a blank line; a single event may carry several data: lines.
    while ((sep = buf.match(/\r?\n\r?\n/))) {
      const raw = buf.slice(0, sep.index);
      buf = buf.slice(sep.index! + sep[0].length);
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data) as T;
      } catch {
        // Keep-alive comments and malformed lines are skipped.
      }
    }
  }
}

/** Throw a readable error for a failed provider call. */
export async function ensureOk(res: Response, provider: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  let detail = body.slice(0, 300);
  try {
    const j = JSON.parse(body);
    detail = j.error?.message ?? j.message ?? j.detail ?? j.error ?? detail;
    if (typeof detail !== "string") detail = JSON.stringify(detail).slice(0, 300);
  } catch {
    // Not JSON; use the raw text.
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError(`Invalid ${provider} API key.`, res.status);
  if (res.status === 429) throw new ProviderError(`Rate limited by ${provider}. Try again shortly.`, res.status);
  throw new ProviderError(`${provider} API error (${res.status}): ${detail}`, res.status);
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
