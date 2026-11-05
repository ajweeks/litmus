// Hand-built Anthropic API responses for offline tests: the JSON shape of a non-streaming
// message, and the SSE text of a streamed one. Only the fields the app and the SDK read.

import type { CassetteEntry, RecordedRequest } from "../replay";

const MESSAGES_URL = /^https:\/\/api\.anthropic\.com\/v1\/messages/;

type Block = Record<string, unknown>;

export function usage(input = 500, output = 80) {
  return { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

/** A complete (non-streamed) message. */
export function message(content: Block[], opts: { model?: string; stopReason?: string; usage?: object } = {}) {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: opts.model ?? "claude-haiku-5-5",
    content,
    stop_reason: opts.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: opts.usage ?? usage(),
  };
}

export const textBlock = (text: string, citations?: Block[]): Block => ({ type: "text", text, ...(citations ? { citations } : {}) });

/** What the extractor's structured output looks like. */
export function extraction(
  claims: { quote: string; claim: string; category?: string; duplicate_of?: string | null; related_ids?: string[] }[],
) {
  return message([
    textBlock(
      JSON.stringify({
        claims: claims.map((c) => ({
          quote: c.quote,
          claim: c.claim,
          category: c.category ?? "empirical",
          duplicate_of: c.duplicate_of ?? null,
          related_ids: c.related_ids ?? [],
        })),
      }),
    ),
  ]);
}

export interface FakeVerdict {
  verdict: string;
  importance?: string;
  volatility?: string;
  confidence?: number;
  summary?: string;
  correction?: string;
  sources?: { url: string; title: string; quote: string; stance?: string }[];
}

/** A verifier turn: one search whose results include the sources, a cited sentence, then the submit_verdict tool call. */
export function verdict(v: FakeVerdict, opts: { model?: string } = {}) {
  const sources = v.sources ?? [];
  return message(
    [
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "check" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: sources.map((s) => ({ type: "web_search_result", url: s.url, title: s.title, encrypted_content: "", page_age: null })),
      },
      textBlock(
        "Sources settle it.",
        sources.map((s) => ({ type: "web_search_result_location", url: s.url, title: s.title, cited_text: s.quote, encrypted_index: "" })),
      ),
      {
        type: "tool_use",
        id: "toolu_1",
        name: "submit_verdict",
        input: {
          verdict: v.verdict,
          importance: v.importance ?? "minor",
          volatility: v.volatility ?? "stable",
          confidence: v.confidence ?? 0.9,
          summary: v.summary ?? "",
          correction: v.correction ?? "",
          sources: sources.map((s) => ({ url: s.url, title: s.title, quote: s.quote, stance: s.stance ?? "supports" })),
        },
      },
    ],
    { stopReason: "tool_use", model: opts.model, usage: { ...usage(2000, 300), server_tool_use: { web_search_requests: 1 } } },
  );
}

/** The SSE text of a streamed reply consisting of text deltas. */
export function stream(text: string, opts: { model?: string; chunk?: number; thinking?: string } = {}) {
  const model = opts.model ?? "claude-opus-5-5";
  const size = opts.chunk ?? 7;
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev("message_start", {
    message: { ...message([], { model, stopReason: undefined }), stop_reason: null, usage: usage(40, 1) },
  });
  let index = 0;
  if (opts.thinking) {
    out += ev("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
    out += ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: opts.thinking } });
    out += ev("content_block_stop", { index });
    index++;
  }
  out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
  for (let i = 0; i < text.length; i += size)
    out += ev("content_block_delta", { index, delta: { type: "text_delta", text: text.slice(i, i + size) } });
  out += ev("content_block_stop", { index });
  out += ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 60 } });
  out += ev("message_stop", {});
  return out;
}

/** The request body as the SDK sent it, parsed; `{}` if it isn't JSON. */
export function bodyOf(req: RecordedRequest): Record<string, unknown> {
  try {
    return JSON.parse(req.body ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

const systemOf = (req: RecordedRequest) => {
  const s = bodyOf(req).system;
  return typeof s === "string" ? s : "";
};

/** The prompt text of the (single) user turn of a request, for matching fixtures to calls. */
export function userTextOf(req: RecordedRequest): string {
  const msgs = bodyOf(req).messages as { role: string; content: unknown }[] | undefined;
  const user = msgs?.find((m) => m.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return (user.content as { type: string; text?: string }[]).map((b) => b.text ?? "").join("");
}

const isMessages = (req: RecordedRequest) => req.method === "POST" && MESSAGES_URL.test(req.url);

/** Entry builders; each matches a kind of call the app makes. */
export const anthropic = {
  json(body: object): CassetteEntry["response"] {
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  },
  sse(body: string): CassetteEntry["response"] {
    return { status: 200, headers: { "content-type": "text/event-stream" }, body };
  },
  /** The main chat reply. */
  reply(text: string, opts: Parameters<typeof stream>[1] = {}): CassetteEntry {
    return {
      route: "anthropic reply",
      match: (req) => isMessages(req) && bodyOf(req).stream === true,
      response: anthropic.sse(stream(text, opts)),
    };
  },
  extractor(claims: Parameters<typeof extraction>[0], when?: (user: string) => boolean): CassetteEntry {
    return {
      route: "anthropic extractor",
      match: (req) => isMessages(req) && systemOf(req).startsWith("You are the claim extractor") && (!when || when(userTextOf(req))),
      response: anthropic.json(extraction(claims)),
    };
  },
  verifier(v: FakeVerdict, when?: (user: string) => boolean): CassetteEntry {
    return {
      route: "anthropic verifier",
      match: (req) => isMessages(req) && systemOf(req).startsWith("You are the verifier") && (!when || when(userTextOf(req))),
      response: anthropic.json(verdict(v)),
    };
  },
  summary(text: string): CassetteEntry {
    return {
      route: "anthropic summary",
      match: (req) => isMessages(req) && systemOf(req).startsWith("You write the one-line fact-check note"),
      response: anthropic.json(message([textBlock(text)])),
    };
  },
  title(text: string): CassetteEntry {
    return {
      route: "anthropic title",
      match: (req) => isMessages(req) && systemOf(req).startsWith("You name chats"),
      response: anthropic.json(message([textBlock(text)])),
    };
  },
  /** An API error, in the shape the SDK turns into APIError. */
  error(status: number, message: string): CassetteEntry["response"] {
    return {
      status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
    };
  },
};
