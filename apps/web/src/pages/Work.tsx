import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api.js";
import { Banner } from "../components/Banner.js";
import { RepoChip } from "../components/RepoChip.js";
import { useFocus } from "../lib/filter.js";
import { EXPEDITE_BADGE, EXPEDITE_TITLE, peopleLabel } from "../lib/labels.js";
import { STAGES, STAGE_LABEL, buildWork, type WorkItem } from "../lib/work.js";
import type { BoardCard, EstateSummary, IngestionHealth, MyWork, RunningItem } from "../types.js";

/**
 * Work — the team's list (redesign board 1). Three counters, then every work
 * item in one of three groups: it needs a decision from a person, the factory
 * has it, or it finished this week. A row says who decides and what; opening
 * it goes where that decision is made.
 */
export function WorkPage() {
  const focus = useFocus();
  const added = (useLocation().state as { added?: { number: number; title: string } } | null)?.added ?? null;
  const estates = useQuery({
    queryKey: ["estates"],
    queryFn: () => api.get<{ estates: EstateSummary[]; ingestion: IngestionHealth }>("/api/estates"),
  });
  const board = useQuery({
    queryKey: ["board", focus.key],
    queryFn: () => api.get<{ columns: string[]; cards: BoardCard[] }>(`/api/board${focus.qs}`),
  });
  const myWork = useQuery({ queryKey: ["my-work", focus.key], queryFn: () => api.get<MyWork>(`/api/my-work${focus.qs}`) });
  const running = useQuery({
    queryKey: ["running"],
    queryFn: () => api.get<{ running: RunningItem[] }>("/api/running"),
    refetchInterval: 30_000,
  });

  const ingestion = estates.data?.ingestion;
  const STUCK_MS = 10 * 60_000;
  const webhooksStuck = Boolean(
    ingestion &&
      ingestion.pending > 0 &&
      ingestion.lastReceivedAt &&
      (!ingestion.lastProcessedAt || Date.now() - new Date(ingestion.lastProcessedAt).getTime() > STUCK_MS),
  );

  const loading = board.isLoading || myWork.isLoading;
  const lists = board.data && myWork.data ? buildWork(board.data.cards, myWork.data.needsYou, running.data?.running ?? []) : null;
  const doneThisWeek = lists?.done.filter((w) => w.card.daysInState <= 7) ?? [];

  return (
    <div className="work-page">
      <div className="spread">
        <h1>Work</h1>
        <Link to="/work/new" className="button primary">
          Add work
        </Link>
      </div>
      {added && (
        <Banner tone="success">
          Added #{added.number} {added.title}. The factory reads it and comes back with a plan to approve.
        </Banner>
      )}
      {webhooksStuck && ingestion && (
        <Banner tone="error" technical={`${ingestion.pending} webhook deliveries waiting. Worker or Redis may be down.`}>
          Updates from GitHub are stuck. Ask the host operator to check the worker.
        </Banner>
      )}

      {loading && <p className="muted">Loading…</p>}
      {!loading && !lists && <p className="muted">Could not load the work list.</p>}

      {lists && (
        <>
          <div className="work-counters">
            <Link to="/decisions" className="work-counter you">
              <span className="n">{lists.counts.you}</span>
              <span className="l">{lists.counts.you === 1 ? "needs you" : "need you"}</span>
              <span className="muted">{countsLine(lists.needsDecision)}</span>
            </Link>
            <div className="work-counter">
              <span className="n">{lists.counts.others}</span>
              <span className="l">{lists.counts.others === 1 ? "needs someone else" : "need someone else"}</span>
              <span className="muted">a decision or a test that is not yours</span>
            </div>
            <div className="work-counter working">
              <span className="n">{lists.counts.working}</span>
              <span className="l">the factory is working on</span>
              <span className="muted">nothing to do until it asks</span>
            </div>
          </div>

          <section className="card" aria-labelledby="needs">
            <h2 id="needs">Needs a decision</h2>
            {lists.needsDecision.length === 0 ? (
              <p className="muted">Nothing is waiting on you. The factory is running.</p>
            ) : (
              <>
                <p className="muted">Each line says who decides and what. Open it to decide.</p>
                {lists.needsDecision.map((w) => (
                  <WorkRow item={w} key={w.card.epicId} />
                ))}
              </>
            )}
          </section>

          <section className="card" aria-labelledby="working">
            <h2 id="working">The factory is working</h2>
            {lists.working.length === 0 ? (
              <p className="muted">Nothing is in progress.</p>
            ) : (
              <>
                <p className="muted">Nothing to do. It will ask if it gets stuck.</p>
                {lists.working.map((w) => (
                  <WorkRow item={w} key={w.card.epicId} />
                ))}
              </>
            )}
          </section>

          {doneThisWeek.length > 0 && (
            <section className="card" aria-labelledby="done">
              <h2 id="done">
                Done this week <span className="muted">({doneThisWeek.length})</span>
              </h2>
              <p className="muted">{doneThisWeek.map((w) => w.card.title).join(" · ")}</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function countsLine(items: WorkItem[]): string {
  const n = (ask: string) => items.filter((w) => w.ask === ask).length;
  const parts = [
    [n("answer"), "answer"],
    [n("decide"), "approval"],
    [n("run"), "test run"],
    [n("release") + n("ship"), "release"],
    [n("start"), "start"],
  ] as const;
  const said = parts.filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}${c === 1 ? "" : "s"}`);
  return said.length > 0 ? said.join(", ") : "all quiet";
}

export function StageDots({ stage }: { stage: WorkItem["stage"] }) {
  if (!stage) return null;
  const at = STAGES.indexOf(stage);
  return (
    <span className="stage-dots" aria-label={`stage ${at + 1} of ${STAGES.length}`}>
      {STAGES.map((s, i) => (
        <i key={s} className={i < at ? "d" : i === at ? "c" : ""} />
      ))}
    </span>
  );
}

export function StageChip({ item }: { item: WorkItem }) {
  const tone = item.ask === "answer" ? "halt" : item.ask === "run" ? "wait" : item.ask ? "decide" : "";
  return <span className={`stage-chip ${tone}`}>{item.stage ? STAGE_LABEL[item.stage] : peopleLabel(item.card.state)}</span>;
}

function WorkRow({ item: w }: { item: WorkItem }) {
  const [verb, ...rest] = w.pointer.split(": ");
  const hasVerb = rest.length > 0 && w.ask;
  return (
    <Link to={w.link} className="work-row">
      <span>
        <StageChip item={w} />
        <StageDots stage={w.stage} />
      </span>
      <span>
        <span className="work-row-title">{w.card.title}</span>
        <span className="work-pointer">
          {hasVerb ? (
            <>
              <strong>{verb}:</strong> {rest.join(": ")}
            </>
          ) : (
            w.pointer
          )}
        </span>
        <span className="work-row-meta">
          <RepoChip fullName={w.card.repo} />
          {w.card.expedited && (
            <span className="badge expedite" title={EXPEDITE_TITLE}>
              {EXPEDITE_BADGE}
            </span>
          )}
        </span>
      </span>
      <span className="work-row-who">{w.who}</span>
    </Link>
  );
}
