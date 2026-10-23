import type { ClaimStatus } from "@/lib/types";

export const STATUS: Record<ClaimStatus, { label: string; icon: string }> = {
  pending: { label: "Queued", icon: "·" },
  verifying: { label: "Checking", icon: "·" },
  supported: { label: "Supported", icon: "✓" },
  partially_supported: { label: "Partly right", icon: "~" },
  misleading: { label: "Misleading", icon: "!" },
  refuted: { label: "Incorrect", icon: "✕" },
  unverifiable: { label: "Unverified", icon: "?" },
  skipped: { label: "Not checked", icon: "–" },
  error: { label: "Check failed", icon: "!" },
};

/** Lower sorts first: problems before confirmations. */
export const SEVERITY: Record<ClaimStatus, number> = {
  refuted: 0,
  misleading: 1,
  partially_supported: 2,
  unverifiable: 3,
  error: 4,
  verifying: 5,
  pending: 6,
  supported: 7,
  skipped: 8,
};

export const isPending = (s: ClaimStatus) => s === "pending" || s === "verifying";

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.001) return "<$0.001";
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`;
}
