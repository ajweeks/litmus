// Triage with a decision model (TypeSafe's Jev, Perplexity's Decider, Nace.AI's Drex, ...) through
// OpenRouter's Decisions API, or Jev directly through TypeSafe's own API (same request shape). Decision models return probabilities over a fixed set of options rather
// than generated text, so the confidence is a real distribution, not a number the model wrote out.
// Claims the model is confident are accurate skip the expensive web check.
//
// The Decisions API is alpha: request and response shapes may change.

import { TRIAGE_CRITERIA, TRIAGE_INSTRUCTIONS } from "./prompts";
import { ProviderError, statusMessage } from "./sse";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_INPUT_USD_PER_M = 0.042; // output tokens are free

/** OpenRouter ids are "vendor/model"; TypeSafe's own are bare ("jev-latest"). */
export const triageProvider = (model: string): "openrouter" | "typesafe" =>
  /^jev-[\w.\-]+$/.test(model) ? "typesafe" : "openrouter";

/** Suggestions for the settings field; any OpenRouter decision-model id works. */
export const DECISION_MODELS = [
  { id: "jev-latest", label: "Jev (TypeSafe key)" },
  { id: "~typesafe/jev-latest", label: "Jev (OpenRouter key)" },
  { id: "perplexity/pplx-decider-v1.2", label: "Decider v1.2 (Perplexity)" },
  { id: "perplexity/pplx-decider-flash-v1.2", label: "Decider Flash v1.2 (Perplexity)" },
];

/** Model ids are passed through to OpenRouter, so restrict them to a safe charset. */
export const isValidTriageModel = (model: string) => model === "" || /^~?[\w.\-/:]{1,100}$/.test(model);

export interface TriageScore {
  /** Probability (0–1) that the claim is accurate. */
  pAccurate: number;
  /** The model version that answered, as reported by the API. */
  model: string;
  costUsd: number;
}

interface DecisionResponse {
  model?: string;
  answers?: Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number }>;
  usage?: { cost?: number; input_tokens?: number };
}

/** Score one claim. Throws on API errors so the caller can fall back to a full check. */
export async function triageClaim(opts: {
  model: string;
  claim: string;
  context: string;
  key: string;
}): Promise<TriageScore> {
  const direct = triageProvider(opts.model) === "typesafe";
  const res = await fetch(direct ? TYPESAFE_ENDPOINT : OPENROUTER_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      state: { claim: opts.claim, context: opts.context },
      questions: {
        accuracy: { type: "choice", instructions: TRIAGE_INSTRUCTIONS, criteria: TRIAGE_CRITERIA },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok)
    throw new ProviderError(statusMessage(direct ? "TypeSafe" : "OpenRouter", res.status, await res.text()), res.status);
  const body = (await res.json()) as DecisionResponse;
  const p = body.answers?.accuracy?.probabilities?.accurate;
  if (typeof p !== "number" || !Number.isFinite(p)) throw new Error("Decisions API returned no probability.");
  const costUsd = direct ? ((body.usage?.input_tokens ?? 0) * TYPESAFE_INPUT_USD_PER_M) / 1e6 : (body.usage?.cost ?? 0);
  return { pAccurate: Math.min(1, Math.max(0, p)), model: body.model ?? opts.model, costUsd };
}
