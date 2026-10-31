import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { Banner } from "../components/Banner.js";
import { IssuePeek } from "../components/IssuePeek.js";
import { RepoChip } from "../components/RepoChip.js";
import { PipelineBoard } from "../components/PipelineBoard.js";
import { RecentRuns } from "../components/RecentRuns.js";
import { RunningCards } from "../components/RunningCards.js";
import { SegmentedTabs } from "../components/SegmentedTabs.js";
import { useHalt } from "../components/Shell.js";
import { useFocus } from "../lib/filter.js";
import { EXPEDITE_BADGE, EXPEDITE_TITLE, PHASE_LABELS, attentionReason, factoryShort, peopleLabel } from "../lib/labels.js";
import type { AttentionEntry, BoardCard, EstateSummary, IngestionHealth, MineRow, MyWork, Phase, WaitingRow } from "../types.js";

const PHASE_ORDER: Phase[] = ["held", "specifying", "planning", "building", "shipping"];

export function MissionControl() {
  const [tab, setTab] = useState<"me" | "factory">("me");
  const [peekId, setPeekId] = useState<string | null>(null);
  const estates = useQuery({
    queryKey: ["estates"],
    queryFn: () => api.get<{ estates: EstateSummary[]; ingestion: IngestionHealth }>("/api/estates"),
  });
  const anyStale = estates.data?.estates.some((e) => e.stale);
  const ingestion = estates.data?.ingestion;
  const STUCK_MS = 10 * 60_000;
  const webhooksNeverArrived = Boolean(estates.data && estates.data.estates.length > 0 && ingestion && !ingestion.lastReceivedAt);
  const webhooksStuck = Boolean(
    ingestion &&
      ingestion.pending > 0 &&
      ingestion.lastReceivedAt &&
      (!ingestion.lastProcessedAt || Date.now() - new Date(ingestion.lastProcessedAt).getTime() > STUCK_MS),
  );

  return (
    <div>
      <h1>My work</h1>
      {webhooksNeverArrived && (
        <Banner
          tone="error"
          technical="Check the GitHub App webhook URL and secret, then Recent deliveries. Until webhooks work, reconcile from Onboarding."
        >
          New issues will not appear on their own. Reconcile from Onboarding to import current GitHub state.
        </Banner>
      )}
      {webhooksStuck && ingestion && (
        <Banner tone="error" technical={`${ingestion.pending} webhook deliveries waiting. Worker or Redis may be down.`}>
          Updates from GitHub are stuck. Ask the host operator to check the worker.
        </Banner>
      )}
      {anyStale && !webhooksNeverArrived && !webhooksStuck && (
        <Banner tone="stale" technical="Trigger a reconcile from Onboarding if this persists.">
          Some organisations have not synced recently — this view may be behind GitHub.
        </Banner>
      )}
      {estates.data && estates.data.estates.some((e) => e.repos.some((r) => !r.factoryEnabled)) && (
        <div className="banner info">
          Some connected repositories are not factory-enabled yet.{" "}
          <Link to="/onboarding">Finish setup on Onboarding</Link>.
        </div>
      )}

      <SegmentedTabs
        ariaLabel="Mission control view"
        items={[
          { id: "me", label: "My work" },
          { id: "factory", label: "Factory" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "me" ? <MyWorkTab onPeek={setPeekId} /> : <FactoryTab estates={estates.data?.estates} onPeek={setPeekId} />}
      {peekId && <IssuePeek issueId={peekId} onClose={() => setPeekId(null)} />}
    </div>
  );
}

function MyWorkTab({ onPeek }: { onPeek: (id: string) => void }) {
  const focus = useFocus();
  const { setHalt } = useHalt();
  const myWork = useQuery({ queryKey: ["my-work", focus.key], queryFn: () => api.get<MyWork>(`/api/my-work${focus.qs}`) });

  useEffect(() => {
    const first = myWork.data?.needsYou[0];
    if (!first || (first.rank !== 1 && first.kind !== "gate")) {
      setHalt(null);
      return;
    }
    setHalt({
      title: attentionReason(first.kind, first.rank, first.whyYou, first.state),
      detail: first.question ?? first.title,
      actionLabel: "Open",
      onAction: () => onPeek(first.issueId),
    });
    return () => setHalt(null);
  }, [myWork.data, onPeek, setHalt]);

  if (myWork.isLoading) return <p className="muted">Loading…</p>;
  if (!myWork.data) return <p className="muted">Could not load your work.</p>;
  const { needsYou, mine, waitingOn } = myWork.data;
  return (
    <div>
      <RunningCards />
      <RecentRuns />
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
  const reason = attentionReason(e.kind, e.rank, e.whyYou, e.state);
  const chip = factoryShort(e.state);
  return (
    <div className={`attention-entry rank-${e.rank}`}>
      <span className={`badge ${e.kind}`}>{e.rank === 1 ? "Agent halted" : e.rank === 4 ? "unowned" : reason}</span>
      <span style={{ flex: 1 }}>
        <button type="button" className="link work-row-title" onClick={() => onPeek(e.issueId)}>
          {e.title}
        </button>
        <div className="work-row-meta">
          <RepoChip fullName={e.repo} /> {reason}
          {chip && (
            <span className="badge state" title={e.state ?? undefined}>
              {chip}
            </span>
          )}
          {/* Why this epic's other rows are missing: the factory has them. */}
          {e.expedited && (
            <span className="badge expedite" title={EXPEDITE_TITLE}>
              {EXPEDITE_BADGE}
            </span>
          )}
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
        <button type="button" className="link work-row-title" onClick={() => onPeek(m.issueId)}>
          #{m.number} {m.title}
        </button>
        <div className="work-row-meta">
          <RepoChip fullName={m.repo} /> {peopleLabel(m.state)} ·{" "}
          {m.whyMine === "assigned" ? "assigned to you" : "you filed it"}
          {m.rollup && m.rollup.total > 0 && ` · ${m.rollup.done}/${m.rollup.total} tasks`}
          <span className="badge state">{factoryShort(m.state)}</span>
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
        <button type="button" className="link work-row-title" onClick={() => onPeek(w.issueId)}>
          #{w.number} {w.title}
        </button>
        <div className="work-row-meta">
          <RepoChip fullName={w.repo} /> blocked by{" "}
          <button type="button" className="link" onClick={() => onPeek(b.issueId)}>
            #{b.number} {b.title}
          </button>{" "}
          ({peopleLabel(b.state)}
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
      <RunningCards />
      <RecentRuns />
      <div className="card">
        <h2>Pipeline</h2>
        <p className="muted">Board on larger screens. On a phone this is a phase list.</p>
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
                {e.stale && " (stale)"}
              </span>
            </div>
            <div className="row" style={{ marginTop: "0.3rem" }}>
              {e.repos.map((r) => (
                <span className="badge" key={r.id} title={r.factoryEnabled ? "factory enabled" : "factory not detected"}>
                  {r.factoryEnabled ? "on" : "off"} {r.fullName.split("/")[1]}
                </span>
              ))}
            </div>
          </div>
        ))}
        {estates?.length === 0 && <p className="muted">No organisations connected yet. Connect one from Onboarding.</p>}
      </div>
    </div>
  );
}
