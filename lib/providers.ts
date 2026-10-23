// Model providers: which API a model belongs to, and recognising a pasted API key.
// Shared by the browser (settings) and the server (routing), so nothing secret lives here.

export type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "mistral"
  | "deepseek"
  | "alibaba"
  | "zai"
  | "nvidia"
  | "openrouter"
  | "typesafe";

export const PROVIDERS: Record<Provider, { label: string; keysUrl: string }> = {
  anthropic: { label: "Anthropic", keysUrl: "https://platform.claude.com/settings/keys" },
  openai: { label: "OpenAI", keysUrl: "https://platform.openai.com/api-keys" },
  google: { label: "Google Gemini", keysUrl: "https://aistudio.google.com/apikey" },
  xai: { label: "xAI (Grok)", keysUrl: "https://console.x.ai" },
  mistral: { label: "Mistral", keysUrl: "https://console.mistral.ai/api-keys" },
  deepseek: { label: "DeepSeek", keysUrl: "https://platform.deepseek.com/api_keys" },
  alibaba: { label: "Alibaba Cloud (Qwen)", keysUrl: "https://modelstudio.console.alibabacloud.com" },
  zai: { label: "Z.ai (GLM)", keysUrl: "https://z.ai/manage-apikey/apikey-list" },
  nvidia: { label: "NVIDIA NIM", keysUrl: "https://build.nvidia.com" },
  openrouter: { label: "OpenRouter", keysUrl: "https://openrouter.ai/settings/keys" },
  typesafe: { label: "TypeSafe (Jev)", keysUrl: "https://console.typesafe.ai/keys" },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[];

export type ApiKeys = Partial<Record<Provider, string>>;

/**
 * The providers a key could belong to, from its shape. Most keys have a distinctive prefix. Mistral
 * and Z.ai are told apart by length and alphabet. DeepSeek and Alibaba keys look identical, so
 * those need the user to choose; TypeSafe's format isn't published.
 */
export function candidateProviders(raw: string): Provider[] {
  const key = raw.trim();
  if (key.startsWith("sk-ant-")) return ["anthropic"];
  if (key.startsWith("sk-or-")) return ["openrouter"];
  if (key.startsWith("xai-")) return ["xai"];
  if (key.startsWith("nvapi-")) return ["nvidia"];
  // Older Gemini keys start AIza; AI Studio's newer "auth keys" start AQ.
  if (key.startsWith("AIza") || key.startsWith("AQ.")) return ["google"];
  if (/^sk-[0-9a-f]{32}$/.test(key)) return ["deepseek", "alibaba"];
  if (key.startsWith("sk-")) return ["openai"];
  if (/^[0-9a-f]{32}\.[A-Za-z0-9]{8,}$/.test(key)) return ["zai"];
  if (/^[A-Za-z0-9]{32}$/.test(key)) return ["mistral"];
  return [];
}

/** The provider a key certainly belongs to, or null if it's ambiguous or unrecognised. */
export function detectProvider(raw: string): Provider | null {
  const c = candidateProviders(raw);
  return c.length === 1 ? c[0] : null;
}

/**
 * Why a pasted string clearly isn't an API key, or null if it could be one. Keys are long runs of
 * plain ASCII with no spaces; anything else is a copy-paste slip.
 */
export function keyProblem(raw: string): string | null {
  const key = raw.trim();
  if (!key) return null;
  if (/\s/.test(key)) return "API keys don't contain spaces or line breaks.";
  if (/[^\x21-\x7e]/.test(key)) return "That has characters API keys don't use.";
  if (key.length < 20) return "Too short to be an API key.";
  return null;
}

/** Keys that are stored and switched on. */
export const enabledKeys = (keys: ApiKeys, disabled: Provider[]): ApiKeys =>
  Object.fromEntries(Object.entries(keys).filter(([p, k]) => k && !disabled.includes(p as Provider)));

/** The recognisable prefix of a key, the rest masked: "sk-ant-••••••••". */
export function maskKey(key: string): string {
  const prefix = key.match(/^(sk-(?:ant|or|proj|svcacct|admin)-|sk-|xai-|nvapi-|AIza|AQ\.)/)?.[0] ?? "";
  return `${prefix}${"•".repeat(8)}${key.slice(-4)}`;
}
