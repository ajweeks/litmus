// Server-side knobs read from the environment, in one place so the limits are easy to find
// and to tune. Everything here has a safe default; nothing is required.

const int = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};

/**
 * Whether verdicts may be reused across chats (the shared cache described in the README).
 * Verdicts come from a model reading text the user influenced, so a hostile user can try to
 * plant a wrong verdict for other users to inherit. Set FACTCHECK_SHARED_VERDICTS=off to keep
 * reuse and duplicate-detection within each chat.
 */
export const sharedVerdicts = (): boolean => !/^(off|0|false|no)$/i.test(process.env.FACTCHECK_SHARED_VERDICTS ?? "");

export const LIMITS = {
  /** Largest request body any API route will read, in bytes. */
  bodyBytes: int("FACTCHECK_MAX_BODY_BYTES", 8 * 1024 * 1024),
  /** Longest user message, in characters. */
  messageChars: int("FACTCHECK_MAX_MESSAGE_CHARS", 100_000),
  /** Longest answer that will be scanned for claims; the rest of a longer answer is left unchecked. */
  checkChars: int("FACTCHECK_MAX_CHECK_CHARS", 200_000),
  /** Messages in one chat payload. */
  chatMessages: int("FACTCHECK_MAX_CHAT_MESSAGES", 1000),
  /** Characters across all messages in one chat payload. */
  chatChars: int("FACTCHECK_MAX_CHAT_CHARS", 2_000_000),
  /** Claims the extractor may return for one passage; extra ones are dropped. */
  claimsPerPassage: 40,
  /** Characters kept of a claim's quote and restatement. */
  quoteChars: 1000,
  claimChars: 2000,
  /** Related-claim links accepted per extracted claim. */
  relatedIds: 10,
  /** Sources kept per verdict. */
  sources: 3,
  /** Bytes read from a source page when confirming a quote. */
  pageBytes: 3_000_000,
  /** Largest provider stream buffered while waiting for an event boundary. */
  sseBufferBytes: 4 * 1024 * 1024,
};
