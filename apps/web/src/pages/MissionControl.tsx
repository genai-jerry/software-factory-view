import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import type { AttentionEntry, BoardCard, EstateSummary } from "../types.js";

const STATE_SHORT: Record<string, string> = {
  "factory:intake": "intake",
  "factory:spec-ready": "spec-ready",
  "factory:spec-approved": "spec-approved",
  "factory:planned": "planned",
  "factory:design-ready": "design-ready",
  "factory:design-approved": "design-approved",
  "factory:ready": "ready",
  "factory:in-review": "in-review",
  "factory:in-test": "in-test",
  "factory:ready-to-ship": "ready-to-ship",
  "factory:deployed": "deployed",
};

export function MissionControl() {
  const attention = useQuery({ queryKey: ["attention"], queryFn: () => api.get<{ entries: AttentionEntry[] }>("/api/attention") });
  const board = useQuery({ queryKey: ["board"], queryFn: () => api.get<{ columns: string[]; cards: BoardCard[] }>("/api/board") });
  const estates = useQuery({ queryKey: ["estates"], queryFn: () => api.get<{ estates: EstateSummary[] }>("/api/estates") });

  const anyStale = estates.data?.estates.some((e) => e.stale);

  return (
    <div>
      <h1>Mission control</h1>
      {anyStale && (
        <div className="banner stale">
          Some estates have not synced recently — the view may be stale. Trigger a reconcile from the Onboarding page, and check
          that webhooks are reaching the Console.
        </div>
      )}

      <div className="card">
        <h2>What needs you</h2>
        {attention.isLoading && <p className="muted">Loading…</p>}
        {attention.data && attention.data.entries.length === 0 && <p className="muted">Nothing is waiting on you. The factory is running.</p>}
        {attention.data?.entries.map((e, i) => (
          <div className="attention-entry" key={i}>
            <span className={`badge ${e.kind}`}>{e.kind}</span>
            <span style={{ flex: 1 }}>
              <Link to={e.link}>{e.title}</Link>
              <div className="why">
                {e.repo} — {e.whyYou}
              </div>
            </span>
            <span className="age">{e.ageDays === 0 ? "today" : `${e.ageDays}d`}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Pipeline board</h2>
        {board.data && (
          <div className="board">
            {board.data.columns.map((col) => {
              const cards = board.data.cards.filter((c) => c.state === col && c.open);
              return (
                <div className="board-col" key={col}>
                  <h4>
                    {STATE_SHORT[col] ?? col} {cards.length > 0 && `(${cards.length})`}
                  </h4>
                  {cards.map((c) => (
                    <Link to={`/epics/${c.epicId}`} key={c.epicId} style={{ color: "inherit", textDecoration: "none" }}>
                      <div className={`board-card${c.blocked ? " blocked" : ""}`}>
                        <div>
                          #{c.number} {c.title}
                        </div>
                        <div className="meta">
                          <span>{c.repo.split("/")[1]}</span>
                          <span>{c.daysInState}d in state</span>
                          {c.tasks.total > 0 && (
                            <span>
                              {c.tasks.done}/{c.tasks.total} tasks
                            </span>
                          )}
                          {c.blocked && <span className="badge blocked">blocked</span>}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Estate health</h2>
        {estates.data?.estates.map((e) => (
          <div key={e.id} style={{ marginBottom: "0.75rem" }}>
            <div className="spread">
              <strong>{e.name}</strong>
              <span className="muted">
                last sync: {e.lastSyncedAt ? new Date(e.lastSyncedAt).toLocaleString() : "never"}
                {e.stale && " ⚠"}
              </span>
            </div>
            <div className="row" style={{ marginTop: "0.3rem" }}>
              {e.repos.map((r) => (
                <span className="badge" key={r.id} title={r.factoryEnabled ? "factory enabled" : "factory not detected"}>
                  {r.factoryEnabled ? "✓" : "○"} {r.fullName.split("/")[1]}
                </span>
              ))}
            </div>
          </div>
        ))}
        {estates.data?.estates.length === 0 && (
          <p className="muted">
            No estates yet. Install the GitHub App on your org, then reload — the installation webhook creates the estate.
          </p>
        )}
      </div>
    </div>
  );
}
