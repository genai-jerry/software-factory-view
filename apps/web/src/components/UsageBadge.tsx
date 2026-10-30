import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import type { FactoryUsage } from "../types.js";

/** 1234 → "1.2k", 1_412_000 → "1.4M". */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A reported share of the five-hour allowance, when a run ever carried one. */
export function fiveHourPercent(rateLimit: Record<string, unknown> | null): number | null {
  const five = rateLimit?.["five_hour"];
  const pct = five && typeof five === "object" ? (five as Record<string, unknown>)["used_percentage"] : null;
  return typeof pct === "number" ? Math.round(pct) : null;
}

/**
 * Header badge: how much Claude the factory used in the last five hours, and
 * whether a usage limit has stopped it. A subscription's remaining allowance
 * has no headless source, so the percentage shows only if a run reported one.
 */
export function UsageBadge() {
  const q = useQuery({
    queryKey: ["factory-usage"],
    queryFn: () => api.get<{ usage: FactoryUsage | null }>("/api/orchestrator/usage"),
    refetchInterval: 60_000,
  });
  const u = q.data?.usage;
  if (!u) return null;
  const hours = u.window_hours;
  if (u.limit.reached && u.limit.resets_at) {
    const waiting = u.limit.waiting_issues;
    const title =
      `Claude's usage limit stopped the factory. Runs restart on their own after ${clock(u.limit.resets_at)}.` +
      (waiting.length ? `\nWaiting: ${waiting.join(", ")}` : "");
    return (
      <span className="badge usage limit" title={title} role="status">
        Claude limit · resets {clock(u.limit.resets_at)}
        {waiting.length > 0 && ` · ${waiting.length} waiting`}
      </span>
    );
  }
  const pct = fiveHourPercent(u.rate_limit);
  const title =
    `Last ${hours} hours: ${u.runs} runs (${u.active_runs} running), ${u.total_tokens.toLocaleString()} tokens, ` +
    `about $${u.cost_usd.toFixed(2)} at API prices (Claude Code's estimate, not your bill).`;
  return (
    <span className="badge usage" title={title} role="status">
      Claude · {pct !== null ? `${pct}% of 5 h · ` : ""}
      {compactTokens(u.total_tokens)} tokens / {hours} h
    </span>
  );
}
