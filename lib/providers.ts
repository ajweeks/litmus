// Model providers: which API a model belongs to, and recognising a pasted API key.
// Shared by the browser (settings) and the server (routing), so nothing secret lives here.

export type Provider = "anthropic" | "openai" | "google" | "mistral" | "deepseek" | "zai" | "openrouter";

export const PROVIDERS: Record<Provider, { label: string; keysUrl: string }> = {
  anthropic: { label: "Anthropic", keysUrl: "https://platform.claude.com/settings/keys" },
  openai: { label: "OpenAI", keysUrl: "https://platform.openai.com/api-keys" },
  google: { label: "Google Gemini", keysUrl: "https://aistudio.google.com/apikey" },
  mistral: { label: "Mistral", keysUrl: "https://console.mistral.ai/api-keys" },
  deepseek: { label: "DeepSeek", keysUrl: "https://platform.deepseek.com/api_keys" },
  zai: { label: "Z.ai (GLM)", keysUrl: "https://z.ai/manage-apikey/apikey-list" },
  openrouter: { label: "OpenRouter", keysUrl: "https://openrouter.ai/settings/keys" },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[];

export type ApiKeys = Partial<Record<Provider, string>>;

/**
 * Guess the provider from a key's shape. Most have a distinctive prefix; DeepSeek, Mistral and Z.ai
 * don't, so they're told apart by length and alphabet.
 */
export function detectProvider(raw: string): Provider | null {
  const key = raw.trim();
  if (key.startsWith("sk-ant-")) return "anthropic";
  if (key.startsWith("sk-or-")) return "openrouter";
  // Older Gemini keys start AIza; AI Studio's newer "auth keys" start AQ.
  if (key.startsWith("AIza") || key.startsWith("AQ.")) return "google";
  if (/^sk-[0-9a-f]{32}$/.test(key)) return "deepseek";
  if (key.startsWith("sk-")) return "openai";
  if (/^[0-9a-f]{32}\.[A-Za-z0-9]{8,}$/.test(key)) return "zai";
  if (/^[A-Za-z0-9]{32}$/.test(key)) return "mistral";
  return null;
}

/** The recognisable prefix of a key, the rest masked: "sk-ant-••••••••". */
export function maskKey(key: string): string {
  const prefix = key.match(/^(sk-(?:ant|or|proj|svcacct|admin)-|sk-|AIza|AQ\.)/)?.[0] ?? "";
  return `${prefix}${"•".repeat(8)}${key.slice(-4)}`;
}
