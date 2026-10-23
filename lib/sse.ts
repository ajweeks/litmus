// Calling the providers that use plain fetch: requests, server-sent-event streams, and turning
// each provider's error format into one readable message.

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** POST to a provider; network failures and error statuses become a ProviderError. */
export async function providerFetch(provider: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    throw new ProviderError(
      `Couldn't reach ${provider}${cause ? ` (${cause})` : ""}. Check your connection, or try again shortly.`,
      0,
    );
  }
  if (!res.ok) throw new ProviderError(statusMessage(provider, res.status, await res.text().catch(() => "")), res.status);
  return res;
}

/**
 * The message inside a provider's error body. Formats seen: {error: {message}} (OpenAI-style,
 * Gemini, DeepSeek, OpenRouter), {error: "..."}, {message} (Mistral), {detail: "..."} or
 * {detail: {message}} or {detail: [{msg}]} (FastAPI-style: NVIDIA, TypeSafe).
 */
export function errorDetail(body: string): string {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  }
  const o = j as Record<string, unknown>;
  const pick = (v: unknown): string | undefined => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(pick).filter(Boolean).join("; ") || undefined;
    if (v && typeof v === "object") {
      const r = v as Record<string, unknown>;
      return pick(r.message) ?? pick(r.msg) ?? pick(r.detail) ?? pick(r.error);
    }
    return undefined;
  };
  return (pick(o.error) ?? pick(o.message) ?? pick(o.detail) ?? body).slice(0, 300);
}

/** A sentence for the user: what went wrong, in plain terms, plus the provider's own words. */
export function statusMessage(provider: string, status: number, body: string): string {
  const detail = errorDetail(body);
  const plain: Record<number, string> = {
    400: `${provider} rejected the request`,
    401: `${provider} didn't accept the API key. Check it in Settings`,
    402: `Your ${provider} account is out of credit`,
    403: `${provider} refused access (the key may lack permission, or the service isn't available in this region)`,
    404: `${provider} doesn't recognise that model, or it isn't available to your key`,
    408: `${provider} timed out`,
    413: `The conversation is too long for ${provider}`,
    422: `${provider} couldn't process the request`,
    429: `${provider} is rate-limiting this key, or its quota is used up. Try again shortly`,
    500: `${provider} had an internal error. Try again`,
    502: `${provider} is having trouble. Try again shortly`,
    503: `${provider} is overloaded or down. Try again shortly`,
    504: `${provider} timed out`,
    529: `${provider} is overloaded. Try again shortly`,
  };
  const head = plain[status] ?? `${provider} returned an error (${status})`;
  return detail ? `${head}: ${detail}` : `${head}.`;
}

/**
 * Yield each event's parsed JSON `data:` payload until the stream ends or sends [DONE]. A payload
 * that is an error (a top-level `error`, as several providers send mid-stream) is thrown.
 */
export async function* readSse<T = unknown>(res: Response, provider: string): AsyncGenerator<T> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      throw new ProviderError(`The connection to ${provider} dropped mid-answer. Try again.`, 0);
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // Keep-alive comments and malformed lines are skipped.
      }
      const err = (parsed as { error?: unknown } | null)?.error;
      if (err) throw new ProviderError(`${provider} stopped with an error: ${errorDetail(JSON.stringify({ error: err }))}`, 0);
      yield parsed as T;
    }
  }
}
