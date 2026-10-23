// Types shared by the server pipeline and the browser UI.

export type Strictness = "facts" | "judgments" | "critique";

export type ClaimStatus =
  | "pending" // extracted, waiting for a verifier slot
  | "verifying"
  | "supported"
  | "partially_supported"
  | "misleading"
  | "refuted"
  | "unverifiable"
  | "skipped" // a triage model judged it very likely accurate, so the web check was skipped
  | "error";

export const FINAL_STATUSES: ClaimStatus[] = [
  "supported",
  "partially_supported",
  "misleading",
  "refuted",
  "unverifiable",
];

/** Statuses worth telling the main model about. */
export const CORRECTABLE_STATUSES: ClaimStatus[] = ["refuted", "misleading", "partially_supported"];

export type ClaimCategory = "empirical" | "interpretive" | "framing";

/** How much an inaccuracy would matter to someone relying on the answer. */
export type Importance = "minor" | "moderate" | "major";
const IMPORTANCE_RANK: Record<Importance, number> = { minor: 0, moderate: 1, major: 2 };

/** How quickly the truth of a claim can change; decides how long a verdict may be reused. */
export type Volatility = "stable" | "slow" | "fast";

/** Reuse window per volatility. `null` means the verdict doesn't expire. */
export const VOLATILITY_TTL_MS: Record<Volatility, number | null> = {
  stable: null,
  slow: 180 * 24 * 3600 * 1000,
  fast: 3 * 24 * 3600 * 1000,
};

/** Only verdicts at least this confident may be reused by later chats. */
export const REUSE_MIN_CONFIDENCE = 0.85;

export type SourceStance = "supports" | "contradicts" | "context";

export interface Source {
  id: string;
  claimId: string;
  url: string;
  title: string;
  quote: string;
  stance: SourceStance;
  /** True if the URL came back from a web search during verification (not recalled by the model). */
  retrieved: boolean;
}

export interface Claim {
  id: string;
  chatId: string;
  messageId: string;
  /** Verbatim span of the assistant message this claim was taken from. */
  quote: string;
  /** Character offsets of `quote` in the message's raw text, or -1 if it could not be located. */
  startOffset: number;
  endOffset: number;
  /** Standalone restatement of the claim, understandable without the chat. */
  claim: string;
  category: ClaimCategory;
  strictness: Strictness;
  status: ClaimStatus;
  confidence: number | null;
  summary: string | null;
  correction: string | null;
  /** For problem verdicts: how much the error matters. Minor ones are hidden by default. */
  importance: Importance | null;
  volatility: Volatility | null;
  /** After this time the verdict is stale and won't be reused; null = never expires. */
  expiresAt: number | null;
  /** A later verification of the same proposition that replaces this one. */
  supersededBy: string | null;
  /** The earlier equivalent claim the extractor matched this one to, if any. */
  duplicateOf: string | null;
  /** Triage model's probability that the claim is accurate, if triage ran. */
  triageConfidence: number | null;
  triageModel: string | null;
  /** True when triage would have skipped the check but it ran anyway as a random audit. */
  triageAudit: boolean;
  extractorModel: string;
  verifierModel: string | null;
  inputTokens: number;
  outputTokens: number;
  searchCount: number;
  costUsd: number;
  /** Set when the verdict was copied from an earlier, equivalent claim instead of re-verified. */
  reusedFrom: string | null;
  /** Message ID of the system note that fed this result back to the main model. */
  fedBackIn: string | null;
  error: string | null;
  createdAt: number;
  verifiedAt: number | null;
  sources: Source[];
  relatedIds: string[];
}

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  /** "corrections" for system notes carrying fact-check results back to the model. */
  kind: "normal" | "corrections" | "correction_request";
  model: string | null;
  /** One-line digest of the fact-check problems in this reply, once every claim is checked. */
  checkSummary: string | null;
  createdAt: number;
  /** What this reply cost (assistant messages only; absent until stored). */
  usage?: MessageUsage;
}

export interface MessageUsage {
  /** The main model writing the reply. */
  tokens: number;
  costUsd: number;
  /** Fact-check spend recorded on the message rather than a claim (the summary line). */
  checkTokens: number;
  checkCostUsd: number;
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatDetail {
  chat: ChatSummary;
  messages: ChatMessage[];
  claims: Claim[];
}

export interface Settings {
  mainModel: string;
  checkerModel: string;
  strictness: Strictness;
  /** Problems below this importance aren't shown, summarised or sent to the model. */
  minImportance: Importance;
  /**
   * Model that guesses each claim's accuracy before the web check: an OpenRouter id
   * ("vendor/model") or a Claude model id. Empty = off, every claim is checked.
   */
  triageModel: string;
  /** Skip the web check when the triage model's probability is at least this. */
  triageThreshold: number;
  /** Fraction of would-be-skipped claims checked anyway, to measure triage calibration. */
  auditRate: number;
  /** Queue unsent corrections to go out with the next message (the button still sends them right away). */
  queueCorrections: boolean;
  /** Also show supported claims in the margin, not only problems. */
  showSupported: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  mainModel: "claude-opus-5-5",
  checkerModel: "claude-haiku-5-5",
  strictness: "facts",
  minImportance: "moderate",
  triageModel: "",
  triageThreshold: 0.9,
  auditRate: 0.1,
  queueCorrections: true,
  showSupported: false,
};

export const MAIN_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
export const CHECKER_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];

/** NDJSON events streamed from POST /api/chat. */
export type StreamEvent =
  | {
      type: "meta";
      chatId: string;
      userMessage: ChatMessage;
      systemMessage: ChatMessage | null;
      assistantMessageId: string;
      fedBackClaimIds: string[];
    }
  | { type: "text"; delta: string }
  | { type: "message_done"; message: ChatMessage }
  | { type: "claim"; claim: Claim }
  | { type: "summary"; message: ChatMessage }
  | { type: "error"; message: string }
  | { type: "end" };

/** A problem verdict that's important enough to show, summarise and feed back. */
export function isNotableProblem(c: Pick<Claim, "status" | "importance">, min: Importance): boolean {
  return CORRECTABLE_STATUSES.includes(c.status) && IMPORTANCE_RANK[c.importance ?? "moderate"] >= IMPORTANCE_RANK[min];
}

/** Whether a verdict is trustworthy and fresh enough to copy into another chat instead of re-checking. */
export function isReusable(c: Claim, now = Date.now()): boolean {
  return (
    FINAL_STATUSES.includes(c.status) &&
    c.status !== "unverifiable" &&
    !c.supersededBy &&
    !c.reusedFrom &&
    (c.confidence ?? 0) >= REUSE_MIN_CONFIDENCE &&
    (c.expiresAt === null || c.expiresAt > now) &&
    c.sources.some((s) => s.retrieved)
  );
}
