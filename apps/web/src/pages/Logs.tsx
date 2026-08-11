import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import type { LogsResponse, LogLevel } from "../types.js";

const LEVEL_COLOUR: Record<string, string> = {
  debug: "var(--text-dim)",
  info: "var(--accent)",
  warn: "var(--amber)",
  error: "var(--red)",
};

/**
 * The application's own logs, for an install where nobody has a shell into the
 * containers. Both processes write here; "worker" is where projection and
 * reconciliation failures appear, which is usually what you are looking for.
 */
export function LogsPage() {
  const [level, setLevel] = useState<LogLevel | "">("");
  const [service, setService] = useState("");
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(true);
  const [saving, setSaving] = useState(false);

  const params = new URLSearchParams();
  if (level) params.set("level", level);
  if (service) params.set("service", service);
  if (search.trim()) params.set("search", search.trim());
  params.set("limit", "300");

  const logs = useQuery<LogsResponse, ApiError>({
    queryKey: ["logs", level, service, search],
    queryFn: () => api.get<LogsResponse>(`/api/logs?${params.toString()}`),
    refetchInterval: live ? 3000 : false,
    retry: false,
  });

  const changeLevel = (next: string) => {
    setSaving(true);
    api
      .post("/api/logs/level", { level: next })
      .then(() => logs.refetch())
      .finally(() => setSaving(false));
  };

  if (logs.isError) {
    return (
      <div className="card">
        <h2>Logs</h2>
        <div className="banner error">{logs.error.message}</div>
        {logs.error.status === 403 && <p className="muted">Logs span every connected org, so they are owner/admin only.</p>}
      </div>
    );
  }

  const events = logs.data?.events ?? [];

  return (
    <div className="card">
      <h2 style={{ marginBottom: "0.25rem" }}>Logs</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Most recent {events.length} lines from the API and worker. Secrets are masked before anything is stored, and the table
        keeps a rolling window rather than full history.
      </p>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center", margin: "1rem 0" }}>
        <label className="muted">
          Show{" "}
          <select value={level} onChange={(e) => setLevel(e.target.value as LogLevel | "")}>
            <option value="">everything recorded</option>
            <option value="debug">debug and up</option>
            <option value="info">info and up</option>
            <option value="warn">warn and up</option>
            <option value="error">errors only</option>
          </select>
        </label>
        <label className="muted">
          From{" "}
          <select value={service} onChange={(e) => setService(e.target.value)}>
            <option value="">both</option>
            <option value="api">api</option>
            <option value="worker">worker</option>
          </select>
        </label>
        <input placeholder="filter text…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: "14rem" }} />
        <label className="muted">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> live
        </label>

        <span style={{ marginLeft: "auto" }} className="muted">
          Recording at{" "}
          <select value={logs.data?.level ?? "info"} disabled={saving} onChange={(e) => changeLevel(e.target.value)}>
            {(logs.data?.levels ?? ["debug", "info", "warn", "error"]).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>{" "}
          {saving ? "saving…" : null}
        </span>
      </div>

      <p className="muted" style={{ fontSize: "0.8rem", marginTop: "-0.5rem" }}>
        Changing the recording level takes effect immediately for the API and within about 15 seconds for the worker. It
        persists, so turn it back down after you have what you need — debug is noisy and the window fills faster.
      </p>

      {events.length === 0 ? (
        <p className="muted">Nothing recorded yet at this level.</p>
      ) : (
        <div
          style={{
            maxHeight: "60vh",
            overflowY: "auto",
            overflowX: "auto",
            background: "var(--bg-raised)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "0.5rem 0.75rem",
            fontFamily: "ui-monospace, monospace",
            fontSize: "0.78rem",
          }}
        >
          {events.map((e) => (
            <div key={e.id} style={{ display: "flex", gap: "0.6rem", padding: "0.1rem 0", whiteSpace: "pre-wrap" }}>
              <span className="muted" style={{ whiteSpace: "nowrap" }}>
                {new Date(e.ts).toLocaleTimeString()}
              </span>
              <span style={{ color: LEVEL_COLOUR[e.level] ?? "var(--text)", width: "3.2rem", flexShrink: 0 }}>{e.level}</span>
              <span className="muted" style={{ width: "3.6rem", flexShrink: 0 }}>
                {e.service}
              </span>
              <span style={{ minWidth: 0 }}>
                {e.message}
                {e.context ? <span className="muted"> {JSON.stringify(e.context)}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
