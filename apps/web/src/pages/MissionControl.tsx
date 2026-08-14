import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { FilterBar } from "../components/FilterBar.js";
import { IssuePeek } from "../components/IssuePeek.js";
import { RepoChip } from "../components/RepoChip.js";
import { PipelineBoard } from "../components/PipelineBoard.js";
import { useFocus } from "../lib/filter.js";
import type { AttentionEntry, BoardCard, EstateSummary, MineRow, MyWork, Phase, WaitingRow } from "../types.js";

const PHASE_ORDER: Phase[] = ["held", "specifying", "planning", "building", "shipping"];
const PHASE_LABELS: Record<Phase, string> = {
  specifying: "Being specified",
  planning: "Being planned",
  building: "Being built",
  shipping: "Shipping",
  held: "Held",
};

/**
 * Mission control, individual-first (plan 07 §4): "My work" — needs you /
 * yours in flight / waiting on others — is the landing tab; the whole-factory
 * board and organisation health live behind the Factory tab. Every row opens the
 * peek drawer; the workspace is one more click.
 */
export function MissionControl() {
  const [tab, setTab] = useState<"me" | "factory">("me");
  const [peekId, setPeekId] = useState<string | null>(null);
  const estates = useQuery({ queryKey: ["estates"], queryFn: () => api.get<{ estates: EstateSummary[] }>("/api/estates") });
  const anyStale = estates.data?.estates.some((e) => e.stale);

  return (
    <div>
      <h1>Mission control</h1>
      <FilterBar />
      {anyStale && (
        <div className="banner stale">
          Some organisations have not synced recently — the view may be stale. Trigger a reconcile from the Onboarding page, and check
          that webhooks are reaching the Console.
        </div>
      )}
      {estates.data && estates.data.estates.some((e) => e.repos.some((r) => !r.factoryEnabled)) && (
        <div className="banner info">
          Some connected repositories are not factory-enabled yet.{" "}
          <Link to="/onboarding">Finish setup on Onboarding</Link> — labels, secrets, and the enablement PR — or work from here
          if the factory was already enabled by hand.
        </div>
      )}

      <div className="tabs">
        <button className={tab === "me" ? "active" : ""} onClick={() => setTab("me")}>
          My work
        </button>
        <button className={tab === "factory" ? "active" : ""} onClick={() => setTab("factory")}>
          Factory
        </button>
      </div>

      {tab === "me" ? <MyWorkTab onPeek={setPeekId} /> : <FactoryTab estates={estates.data?.estates} onPeek={setPeekId} />}
      {peekId && <IssuePeek issueId={peekId} onClose={() => setPeekId(null)} />}
    </div>
  );
}

function MyWorkTab({ onPeek }: { onPeek: (id: string) => void }) {
  const focus = useFocus();
  const myWork = useQuery({ queryKey: ["my-work", focus.key], queryFn: () => api.get<MyWork>(`/api/my-work${focus.qs}`) });
  if (myWork.isLoading) return <p className="muted">Loading…</p>;
  if (!myWork.data) return <p className="muted">Could not load your work.</p>;
  const { needsYou, mine, waitingOn } = myWork.data;
  return (
    <div>
      <div className="card">
        <h2>Needs you</h2>
        {needsYou.length === 0 && <p className="muted">Nothing is waiting on you. The factory is running.</p>}
        {needsYou.map((e, i) => (
          <AttentionRow entry={e} key={i} onPeek={onPeek} />
        ))}
      </div>

      <div className="card">
        <h2>Yours, in flight</h2>
        {mine.length === 0 && <p className="muted">No open issues are assigned to you or filed by you.</p>}
        {PHASE_ORDER.filter((p) => mine.some((m) => m.phase === p)).map((phase) => (
          <div key={phase} style={{ marginBottom: "0.5rem" }}>
            <h4 className="phase-head">{PHASE_LABELS[phase]}</h4>
            {mine
              .filter((m) => m.phase === phase)
              .map((m) => (
                <MineRowView row={m} key={m.issueId} onPeek={onPeek} />
              ))}
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Waiting on others</h2>
        {waitingOn.length === 0 && <p className="muted">None of your issues are waiting on a dependency.</p>}
        {waitingOn.map((w, i) => (
          <WaitingRowView row={w} key={i} onPeek={onPeek} />
        ))}
      </div>
    </div>
  );
}

function AttentionRow({ entry: e, onPeek }: { entry: AttentionEntry; onPeek: (id: string) => void }) {
  return (
    <div className={`attention-entry rank-${e.rank}`}>
      <span className={`badge ${e.kind}`}>{e.rank === 4 ? "unowned" : e.kind}</span>
      <span style={{ flex: 1 }}>
        <a
          href="#peek"
          onClick={(ev) => {
            ev.preventDefault();
            onPeek(e.issueId);
          }}
        >
          {e.title}
        </a>
        <div className="why">
          <RepoChip fullName={e.repo} /> {e.whyYou}
        </div>
        {e.question && <div className="question">“{e.question}”</div>}
      </span>
      <span className="age">{e.ageDays === 0 ? "today" : `${e.ageDays}d`}</span>
    </div>
  );
}

function MineRowView({ row: m, onPeek }: { row: MineRow; onPeek: (id: string) => void }) {
  return (
    <div className={`attention-entry quiet${m.blocked ? " held-row" : ""}`}>
      <span style={{ flex: 1 }}>
        <a
          href="#peek"
          onClick={(ev) => {
            ev.preventDefault();
            onPeek(m.issueId);
          }}
        >
          #{m.number} {m.title}
        </a>
        <div className="why">
          <RepoChip fullName={m.repo} /> {m.state?.replace("factory:", "") ?? "no state"} ·{" "}
          {m.whyMine === "assigned" ? "assigned to you" : "you filed it"}
          {m.rollup && m.rollup.total > 0 && ` · ${m.rollup.done}/${m.rollup.total} tasks`}
        </div>
      </span>
      <span className="age">{m.freshness.quietDays === 0 ? "moved today" : `quiet ${m.freshness.quietDays}d`}</span>
    </div>
  );
}

function WaitingRowView({ row: w, onPeek }: { row: WaitingRow; onPeek: (id: string) => void }) {
  const b = w.blocker;
  return (
    <div className="attention-entry quiet">
      <span style={{ flex: 1 }}>
        <a
          href="#peek"
          onClick={(ev) => {
            ev.preventDefault();
            onPeek(w.issueId);
          }}
        >
          #{w.number} {w.title}
        </a>
        <div className="why">
          <RepoChip fullName={w.repo} /> blocked by{" "}
          <a
            href="#peek"
            onClick={(ev) => {
              ev.preventDefault();
              onPeek(b.issueId);
            }}
          >
            #{b.number} {b.title}
          </a>{" "}
          ({b.state?.replace("factory:", "") ?? "no state"}
          {b.assignees.length > 0 && ` · ${b.assignees.map((a) => `@${a}`).join(", ")}`}
          {b.ageDays !== null && ` · ${b.ageDays}d`})
        </div>
      </span>
    </div>
  );
}

function FactoryTab({ estates, onPeek }: { estates: EstateSummary[] | undefined; onPeek: (id: string) => void }) {
  const focus = useFocus();
  const board = useQuery({
    queryKey: ["board", focus.key],
    queryFn: () => api.get<{ columns: string[]; cards: BoardCard[] }>(`/api/board${focus.qs}`),
  });
  return (
    <div>
      <div className="card">
        <h2>Pipeline board</h2>
        {board.isLoading && <p className="muted">Loading…</p>}
        {board.data && <PipelineBoard columns={board.data.columns} cards={board.data.cards} onPeek={onPeek} />}
      </div>

      <div className="card">
        <h2>Organisation health</h2>
        {estates?.map((e) => (
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
        {estates?.length === 0 && (
          <p className="muted">
            No organisations connected yet. Install the GitHub App on your org, then reload — the installation webhook creates the connection.
          </p>
        )}
      </div>
    </div>
  );
}

