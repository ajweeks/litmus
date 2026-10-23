import type { ChatMessage, Claim } from "@/lib/types";
import { formatCost } from "./status";

const BRANDS: Record<string, string> = { gpt: "GPT", glm: "GLM", deepseek: "DeepSeek" };

/** "claude-opus-5-5" → "Opus 5.5", "~typesafe/jev-latest" → "Jev", "openai/gpt-6-luna" → "GPT-6 Luna". */
export function modelLabel(id: string): string {
  const parts = id
    .split("/")
    .pop()!
    .replace(/^~/, "")
    .replace(/^(claude|pplx)-/, "")
    .replace(/-latest$/, "")
    .split("-");
  const out: string[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (/^\d+$/.test(p) && prev && /\d$/.test(prev)) out[out.length - 1] = `${prev}.${p}`;
    else if (/^\d/.test(p) && prev === "GPT") out[out.length - 1] = `GPT-${p}`;
    else out.push(BRANDS[p] ?? (/^v\d/.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)));
  }
  return out.join(" ");
}

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);

/** This chat's spend, split between the model answering and the models checking it. */
export function UsageMeter({ messages, claims }: { messages: ChatMessage[]; claims: Claim[] }) {
  const replies = messages.filter((m) => m.role === "assistant");
  const main = {
    models: new Set(replies.flatMap((m) => (m.model ? [m.model] : []))),
    tokens: replies.reduce((n, m) => n + (m.usage?.tokens ?? 0), 0),
    cost: replies.reduce((n, m) => n + (m.usage?.costUsd ?? 0), 0),
  };
  const check = {
    models: new Set(
      claims.flatMap((c) => [c.verifierModel ?? c.extractorModel, c.triageModel].filter((x): x is string => !!x)),
    ),
    tokens:
      claims.reduce((n, c) => n + c.inputTokens + c.outputTokens, 0) +
      replies.reduce((n, m) => n + (m.usage?.checkTokens ?? 0), 0),
    cost: claims.reduce((n, c) => n + c.costUsd, 0) + replies.reduce((n, m) => n + (m.usage?.checkCostUsd ?? 0), 0),
  };
  if (!main.tokens && !check.tokens) return null;

  const row = (label: string, u: typeof main) => (
    <div className="usage__row">
      <span className="usage__models">{[...u.models].map(modelLabel).join(" · ") || label}</span>
      <span>{tokens(u.tokens)} tok</span>
      <span>{formatCost(u.cost)}</span>
    </div>
  );
  return (
    <div className="usage" title="This chat's usage. Costs are estimates from list prices.">
      {row("Answer", main)}
      {row("Check", check)}
    </div>
  );
}
