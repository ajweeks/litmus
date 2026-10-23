import type { ChatMessage, Claim } from "@/lib/types";
import { modelLabel } from "@/lib/models";
import { formatCost } from "./status";

export { modelLabel };

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);

/** This chat's spend, split between the model answering and the models checking it. Opens settings on click. */
export function UsageMeter({
  messages,
  claims,
  onClick,
}: {
  messages: ChatMessage[];
  claims: Claim[];
  onClick: () => void;
}) {
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
    <button
      className="usage"
      onClick={onClick}
      title="This chat's usage (costs are estimates from list prices). Click to change models."
    >
      {row("Answer", main)}
      {row("Check", check)}
    </button>
  );
}
