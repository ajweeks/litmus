// SQLite storage: the shared cache of checked claims, plus each chat's messages while a request
// for it is running. Chat history itself lives in the user's browser (lib/chatStore.ts); the
// route imports the chat at the start of a request and forgets it at the end, so prompts and
// replies aren't kept here. Claims are kept, so later chats can reuse their verdicts.
//
// Everything goes through the functions exported here, so swapping in a hosted
// Postgres (for a database shared between users) means reimplementing this file only.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type {
  ChatMessage,
  ChatSummary,
  Claim,
  ClaimStatus,
  Source,
} from "./types";
import type { Importance, ToolActivity } from "./types";
import { FINAL_STATUSES, isNotableProblem } from "./types";

/** No foreign keys to chats or messages: claims outlive the chat they came from. */
const claimsTable = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  quote TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  claim TEXT NOT NULL,
  category TEXT NOT NULL,
  strictness TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL,
  summary TEXT,
  correction TEXT,
  importance TEXT,
  volatility TEXT,
  expires_at INTEGER,
  superseded_by TEXT,
  duplicate_of TEXT,
  triage_confidence REAL,
  triage_model TEXT,
  triage_audit INTEGER NOT NULL DEFAULT 0,
  extractor_model TEXT NOT NULL,
  verifier_model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  search_count INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  reused_from TEXT,
  fed_back_in TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'normal',
  model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, created_at);

${claimsTable("claims")}
CREATE INDEX IF NOT EXISTS claims_chat ON claims(chat_id, created_at);
CREATE INDEX IF NOT EXISTS claims_status ON claims(status);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  quote TEXT NOT NULL,
  stance TEXT NOT NULL,
  retrieved INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sources_claim ON sources(claim_id);

-- Undirected links between claims that concern the same proposition or topic.
CREATE TABLE IF NOT EXISTS claim_links (
  a TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  b TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  PRIMARY KEY (a, b)
);
`;

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const file = process.env.FACTCHECK_DB_PATH || path.join(process.cwd(), "data", "factcheck.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive column changes for databases created by earlier versions. */
function migrate(d: Database.Database) {
  const columns = (table: string) =>
    (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const add = (table: string, cols: Record<string, string>) => {
    const have = columns(table);
    for (const [name, type] of Object.entries(cols))
      if (!have.includes(name)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  };
  add("messages", {
    check_summary: "TEXT",
    tokens: "INTEGER NOT NULL DEFAULT 0",
    cost_usd: "REAL NOT NULL DEFAULT 0",
    check_tokens: "INTEGER NOT NULL DEFAULT 0",
    check_cost_usd: "REAL NOT NULL DEFAULT 0",
    thinking: "TEXT",
    thinking_ms: "INTEGER",
    activity: "TEXT",
  });
  add("claims", CLAIM_COLUMNS);

  // Older databases tied claims to chats with ON DELETE CASCADE, so forgetting a chat after a
  // request would delete its claims. Rebuild the table without those keys (SQLite can't drop them).
  if ((d.prepare("PRAGMA foreign_key_list(claims)").all() as unknown[]).length) {
    const cols = columns("claims").join(", ");
    d.pragma("foreign_keys = OFF");
    d.transaction(() => {
      d.exec("DROP TABLE IF EXISTS claims_new");
      d.exec(claimsTable("claims_new"));
      add("claims_new", CLAIM_COLUMNS);
      d.exec(`INSERT INTO claims_new (${cols}) SELECT ${cols} FROM claims`);
      d.exec("DROP TABLE claims");
      d.exec("ALTER TABLE claims_new RENAME TO claims");
      d.exec("CREATE INDEX IF NOT EXISTS claims_chat ON claims(chat_id, created_at)");
      d.exec("CREATE INDEX IF NOT EXISTS claims_status ON claims(status)");
    })();
    d.pragma("foreign_keys = ON");
  }
}

const CLAIM_COLUMNS = {
  importance: "TEXT",
  volatility: "TEXT",
  expires_at: "INTEGER",
  superseded_by: "TEXT",
  duplicate_of: "TEXT",
  triage_confidence: "REAL",
  triage_model: "TEXT",
  triage_audit: "INTEGER NOT NULL DEFAULT 0",
};

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

// ---------- chats & messages ----------

type MessageRow = {
  id: string;
  chat_id: string;
  role: ChatMessage["role"];
  content: string;
  kind: ChatMessage["kind"];
  model: string | null;
  check_summary: string | null;
  created_at: number;
  tokens: number;
  cost_usd: number;
  check_tokens: number;
  check_cost_usd: number;
  thinking: string | null;
  thinking_ms: number | null;
  activity: string | null;
};

const toMessage = (r: MessageRow): ChatMessage => ({
  id: r.id,
  chatId: r.chat_id,
  role: r.role,
  content: r.content,
  kind: r.kind,
  model: r.model,
  checkSummary: r.check_summary,
  createdAt: r.created_at,
  usage: { tokens: r.tokens, costUsd: r.cost_usd, checkTokens: r.check_tokens, checkCostUsd: r.check_cost_usd },
  thinking: r.thinking,
  thinkingMs: r.thinking_ms,
  activity: r.activity ? JSON.parse(r.activity) : undefined,
});

/** A server-side chat with a fresh id (the evals use this; the app imports chats from the browser). */
export function createChat(title: string): ChatSummary {
  const now = Date.now();
  const chat = { id: newId("chat"), title, createdAt: now, updatedAt: now };
  getDb()
    .prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(chat.id, chat.title, now, now);
  return chat;
}

export function deleteChat(id: string) {
  getDb().prepare("DELETE FROM chats WHERE id = ?").run(id);
}

export function addMessage(m: Omit<ChatMessage, "id" | "createdAt" | "checkSummary">): ChatMessage {
  // Strictly increasing timestamps keep message order stable even within one millisecond.
  const last = getDb()
    .prepare("SELECT MAX(created_at) AS t FROM messages WHERE chat_id = ?")
    .get(m.chatId) as { t: number | null };
  const createdAt = Math.max(Date.now(), (last.t ?? 0) + 1);
  const msg: ChatMessage = { ...m, id: newId("msg"), checkSummary: null, createdAt };
  getDb()
    .prepare(
      "INSERT INTO messages (id, chat_id, role, content, kind, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(msg.id, msg.chatId, msg.role, msg.content, msg.kind, msg.model, msg.createdAt);
  getDb().prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(createdAt, m.chatId);
  return msg;
}

export function updateMessageContent(id: string, content: string) {
  getDb().prepare("UPDATE messages SET content = ? WHERE id = ?").run(content, id);
}

export function setThinking(id: string, thinking: string, ms: number | null) {
  getDb().prepare("UPDATE messages SET thinking = ?, thinking_ms = ? WHERE id = ?").run(thinking, ms, id);
}

export function setActivity(id: string, activity: ToolActivity[]) {
  getDb().prepare("UPDATE messages SET activity = ? WHERE id = ?").run(JSON.stringify(activity), id);
}

export function setMessageUsage(id: string, tokens: number, costUsd: number) {
  getDb().prepare("UPDATE messages SET tokens = ?, cost_usd = ? WHERE id = ?").run(tokens, costUsd, id);
}

export function addCheckUsage(id: string, tokens: number, costUsd: number) {
  getDb()
    .prepare("UPDATE messages SET check_tokens = check_tokens + ?, check_cost_usd = check_cost_usd + ? WHERE id = ?")
    .run(tokens, costUsd, id);
}

export function setCheckSummary(id: string, summary: string | null) {
  getDb().prepare("UPDATE messages SET check_summary = ? WHERE id = ?").run(summary, id);
}

export function deleteMessage(id: string) {
  getDb().prepare("DELETE FROM messages WHERE id = ?").run(id);
}

export function getMessages(chatId: string): ChatMessage[] {
  const rows = getDb()
    .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at")
    .all(chatId) as MessageRow[];
  return rows.map(toMessage);
}

export function getMessage(id: string): ChatMessage | null {
  const row = getDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
  return row ? toMessage(row) : null;
}

// ---------- claims ----------

type ClaimRow = {
  id: string;
  chat_id: string;
  message_id: string;
  quote: string;
  start_offset: number;
  end_offset: number;
  claim: string;
  category: Claim["category"];
  strictness: Claim["strictness"];
  status: ClaimStatus;
  confidence: number | null;
  summary: string | null;
  correction: string | null;
  importance: Claim["importance"];
  volatility: Claim["volatility"];
  expires_at: number | null;
  superseded_by: string | null;
  duplicate_of: string | null;
  triage_confidence: number | null;
  triage_model: string | null;
  triage_audit: number;
  extractor_model: string;
  verifier_model: string | null;
  input_tokens: number;
  output_tokens: number;
  search_count: number;
  cost_usd: number;
  reused_from: string | null;
  fed_back_in: string | null;
  error: string | null;
  created_at: number;
  verified_at: number | null;
};

type SourceRow = {
  id: string;
  claim_id: string;
  url: string;
  title: string;
  quote: string;
  stance: Source["stance"];
  retrieved: number;
};

function hydrate(rows: ClaimRow[]): Claim[] {
  if (rows.length === 0) return [];
  const d = getDb();
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const sources = d.prepare(`SELECT * FROM sources WHERE claim_id IN (${marks})`).all(...ids) as SourceRow[];
  const links = d
    .prepare(`SELECT a, b FROM claim_links WHERE a IN (${marks}) OR b IN (${marks})`)
    .all(...ids, ...ids) as { a: string; b: string }[];

  return rows.map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    messageId: r.message_id,
    quote: r.quote,
    startOffset: r.start_offset,
    endOffset: r.end_offset,
    claim: r.claim,
    category: r.category,
    strictness: r.strictness,
    status: r.status,
    confidence: r.confidence,
    summary: r.summary,
    correction: r.correction,
    importance: r.importance,
    volatility: r.volatility,
    expiresAt: r.expires_at,
    supersededBy: r.superseded_by,
    duplicateOf: r.duplicate_of,
    triageConfidence: r.triage_confidence,
    triageModel: r.triage_model,
    triageAudit: !!r.triage_audit,
    extractorModel: r.extractor_model,
    verifierModel: r.verifier_model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    searchCount: r.search_count,
    costUsd: r.cost_usd,
    reusedFrom: r.reused_from,
    fedBackIn: r.fed_back_in,
    error: r.error,
    createdAt: r.created_at,
    verifiedAt: r.verified_at,
    sources: sources
      .filter((s) => s.claim_id === r.id)
      .map((s) => ({
        id: s.id,
        claimId: s.claim_id,
        url: s.url,
        title: s.title,
        quote: s.quote,
        stance: s.stance,
        retrieved: !!s.retrieved,
      })),
    relatedIds: links.flatMap((l) => (l.a === r.id ? [l.b] : l.b === r.id ? [l.a] : [])),
  }));
}

export interface ClaimFilter {
  chatId?: string;
  messageId?: string;
  status?: ClaimStatus;
  category?: Claim["category"];
  verifierModel?: string;
  /** Case-insensitive text search over the claim and its quote. */
  q?: string;
  limit?: number;
}

export function listClaims(filter: ClaimFilter = {}): Claim[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.messageId) {
    where.push("message_id = ?");
    args.push(filter.messageId);
  }
  if (filter.category) {
    where.push("category = ?");
    args.push(filter.category);
  }
  if (filter.verifierModel) {
    where.push("verifier_model = ?");
    args.push(filter.verifierModel);
  }
  if (filter.q) {
    where.push("(claim LIKE ? OR quote LIKE ?)");
    args.push(`%${filter.q}%`, `%${filter.q}%`);
  }
  if (filter.chatId) {
    where.push("chat_id = ?");
    args.push(filter.chatId);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  const sql = `SELECT * FROM claims ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY created_at ${filter.chatId ? "ASC" : "DESC"} LIMIT ?`;
  const rows = getDb()
    .prepare(sql)
    .all(...args, filter.limit ?? 1000) as ClaimRow[];
  return hydrate(rows);
}

export function getClaim(id: string): Claim | null {
  const row = getDb().prepare("SELECT * FROM claims WHERE id = ?").get(id) as ClaimRow | undefined;
  return row ? hydrate([row])[0] : null;
}

/** Recent verified claims across all chats, offered to the extractor for de-duplication. */
export function recentVerifiedClaims(limit = 40): Pick<Claim, "id" | "claim" | "status">[] {
  const marks = FINAL_STATUSES.map(() => "?").join(",");
  return getDb()
    .prepare(
      `SELECT id, claim, status FROM claims WHERE status IN (${marks}) AND superseded_by IS NULL AND reused_from IS NULL
       ORDER BY verified_at DESC LIMIT ?`,
    )
    .all(...FINAL_STATUSES, limit) as Pick<Claim, "id" | "claim" | "status">[];
}

export type NewClaim = Pick<
  Claim,
  "chatId" | "messageId" | "quote" | "startOffset" | "endOffset" | "claim" | "category" | "strictness" | "extractorModel" | "duplicateOf"
>;

export function insertClaim(c: NewClaim): Claim {
  const id = newId("clm");
  getDb()
    .prepare(
      `INSERT INTO claims (id, chat_id, message_id, quote, start_offset, end_offset, claim, category, strictness,
        status, duplicate_of, extractor_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      id,
      c.chatId,
      c.messageId,
      c.quote,
      c.startOffset,
      c.endOffset,
      c.claim,
      c.category,
      c.strictness,
      c.duplicateOf,
      c.extractorModel,
      Date.now(),
    );
  return getClaim(id)!;
}

export function setClaimStatus(id: string, status: ClaimStatus, error: string | null = null) {
  getDb().prepare("UPDATE claims SET status = ?, error = ? WHERE id = ?").run(status, error, id);
}

export function saveVerdict(
  id: string,
  v: Pick<
    Claim,
    | "status"
    | "confidence"
    | "summary"
    | "correction"
    | "importance"
    | "volatility"
    | "expiresAt"
    | "verifierModel"
    | "inputTokens"
    | "outputTokens"
    | "searchCount"
    | "costUsd"
    | "reusedFrom"
  > & { sources: Omit<Source, "id" | "claimId">[] },
) {
  const d = getDb();
  d.transaction(() => {
    d.prepare(
      `UPDATE claims SET status = ?, confidence = ?, summary = ?, correction = ?, importance = ?, volatility = ?,
        expires_at = ?, verifier_model = ?,
        input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, search_count = search_count + ?,
        cost_usd = cost_usd + ?, reused_from = ?, error = NULL, verified_at = ?
       WHERE id = ?`,
    ).run(
      v.status,
      v.confidence,
      v.summary,
      v.correction,
      v.importance,
      v.volatility,
      v.expiresAt,
      v.verifierModel,
      v.inputTokens,
      v.outputTokens,
      v.searchCount,
      v.costUsd,
      v.reusedFrom,
      Date.now(),
      id,
    );
    d.prepare("DELETE FROM sources WHERE claim_id = ?").run(id);
    const ins = d.prepare(
      "INSERT INTO sources (id, claim_id, url, title, quote, stance, retrieved) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const s of v.sources) ins.run(newId("src"), id, s.url, s.title, s.quote, s.stance, s.retrieved ? 1 : 0);
  })();
}

/** Add usage that isn't tied to a verdict (e.g. this claim's share of an extraction call). */
export function addClaimUsage(id: string, inputTokens: number, outputTokens: number, costUsd: number) {
  getDb()
    .prepare(
      "UPDATE claims SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ? WHERE id = ?",
    )
    .run(inputTokens, outputTokens, costUsd, id);
}

export function setTriage(id: string, t: { confidence: number; model: string; audit: boolean; skip: boolean }) {
  getDb()
    .prepare(
      `UPDATE claims SET triage_confidence = ?, triage_model = ?, triage_audit = ?,
        status = CASE WHEN ? THEN 'skipped' ELSE status END WHERE id = ?`,
    )
    .run(t.confidence, t.model, t.audit ? 1 : 0, t.skip ? 1 : 0, id);
}

/** Mark an older verdict as replaced by a newer verification of the same proposition. */
export function supersede(oldId: string, newId: string) {
  getDb().prepare("UPDATE claims SET superseded_by = ? WHERE id = ? AND id != ?").run(newId, oldId, newId);
}

export function linkClaims(a: string, b: string) {
  if (a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  getDb().prepare("INSERT OR IGNORE INTO claim_links (a, b) VALUES (?, ?)").run(x, y);
}

/** Notable problem claims in a chat that have finished verifying but haven't been shown to the main model yet. */
export function unsentCorrections(chatId: string, minImportance: Importance): Claim[] {
  return listClaims({ chatId }).filter((c) => isNotableProblem(c, minImportance) && !c.fedBackIn);
}

export function markFedBack(claimIds: string[], messageId: string) {
  const stmt = getDb().prepare("UPDATE claims SET fed_back_in = ? WHERE id = ?");
  getDb().transaction(() => claimIds.forEach((id) => stmt.run(messageId, id)))();
}

/**
 * Load a chat the browser sent so a request can run against it: the chat row and its messages
 * (claims are already here, in the shared cache). Existing rows are updated in place.
 */
export function importChat(
  chat: ChatSummary,
  messages: Pick<ChatMessage, "id" | "role" | "content" | "kind" | "model" | "createdAt">[],
) {
  const d = getDb();
  d.transaction(() => {
    d.prepare(
      `INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
    ).run(chat.id, chat.title, chat.createdAt, chat.updatedAt);
    const put = d.prepare(
      `INSERT INTO messages (id, chat_id, role, content, kind, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content`,
    );
    for (const m of messages) put.run(m.id, chat.id, m.role, m.content, m.kind, m.model, m.createdAt);
  })();
}

/** Claims by id, for a browser catching up on checks that finished while it was away. */
export function getClaims(ids: string[]): Claim[] {
  return ids.flatMap((id) => {
    const c = getClaim(id);
    return c ? [c] : [];
  });
}
