import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { RepoChip } from "../components/RepoChip.js";
import { useFocus } from "../lib/filter.js";
import { STAGE_LABEL, decisionCards, type WorkItem } from "../lib/work.js";
import type { BoardCard, MyWork } from "../types.js";

/**
 * Decisions — what needs a person (redesign board 2). One card per work item
 * that waits on me, in the decision shape: what happened, what I need to do,
 * a few facts, then the buttons. A button is the whole decision; the comment
 * or merge it posts on GitHub stays behind it.
 */
export function DecisionsQueuePage() {
  const focus = useFocus();
  const board = useQuery({
    queryKey: ["board", focus.key],
    queryFn: () => api.get<{ columns: string[]; cards: BoardCard[] }>(`/api/board${focus.qs}`),
  });
  const myWork = useQuery({ queryKey: ["my-work", focus.key], queryFn: () => api.get<MyWork>(`/api/my-work${focus.qs}`) });
  const cards = board.data && myWork.data ? decisionCards(board.data.cards, myWork.data.needsYou) : null;

  return (
    <div>
      <h1>Decisions</h1>
      <p className="muted">Everything that waits for you, most urgent first. Each card is one decision; the buttons are the whole answer.</p>
      {(board.isLoading || myWork.isLoading) && <p className="muted">Loading…</p>}
      {cards && cards.length === 0 && (
        <div className="card">
          <p className="muted">Nothing is waiting on you. The factory is running.</p>
        </div>
      )}
      {cards?.map((w) => (
        <DecisionCard item={w} key={w.card.epicId} />
      ))}
    </div>
  );
}

function ageOf(days: number): string {
  return days === 0 ? "today" : `${days}d`;
}

export function DecisionCard({ item: w }: { item: WorkItem }) {
  const first = w.entries[0];
  const age = first ? ageOf(first.ageDays) : ageOf(w.card.daysInState);
  const stage = w.stage ? STAGE_LABEL[w.stage] : "Held";
  return (
    <article className="card decision-card" aria-label={`${stage}: ${w.card.title}`}>
      <header className="decision-head">
        <span className={`stage-chip ${w.ask === "answer" ? "halt" : w.ask === "run" ? "wait" : "decide"}`}>{stage}</span>
        <Link to={`/work/${w.card.epicId}`} className="work-row-title">
          {w.card.title}
        </Link>
        <span className="muted">
          <RepoChip fullName={w.card.repo} /> · {age}
        </span>
      </header>
      <DecisionBody item={w} />
    </article>
  );
}

function DecisionBody({ item: w }: { item: WorkItem }) {
  switch (w.ask) {
    case "decide":
    case "release":
      return <GateDecision item={w} />;
    case "answer":
      return <AnswerDecision item={w} />;
    case "run":
      return <RunDecision item={w} />;
    case "ship":
      return (
        <>
          <h3>Ship to production</h3>
          <p className="need">You need to: decide whether this goes live for customers now.</p>
          <ul className="facts">
            <li>It is on staging and every check passed.</li>
            <li>Shipping merges the promotion pull requests in order. Today that happens from the item's gate.</li>
          </ul>
          <div className="decision-actions">
            <Link to={w.link} className="button primary">
              Ship to production
            </Link>
            <Link to={`/work/${w.card.epicId}`} className="button">
              Open the item
            </Link>
          </div>
        </>
      );
    case "start":
      return (
        <>
          <h3>Start the build</h3>
          <p className="need">You need to: start the tasks that are ready. {w.pointer.replace(/^Start: /, "")}</p>
          <div className="decision-actions">
            <Link to={w.link} className="button primary">
              See the tasks
            </Link>
          </div>
        </>
      );
    default:
      return null;
  }
}

function useFailure() {
  const [failure, setFailure] = useState<string | null>(null);
  const onError = (e: unknown) => setFailure(e instanceof ApiError ? e.message : "That did not go through. Try again.");
  return { failure, onError, clear: () => setFailure(null) };
}

function GateDecision({ item: w }: { item: WorkItem }) {
  const qc = useQueryClient();
  const [changes, setChanges] = useState<string | null>(null);
  const { failure, onError, clear } = useFailure();
  const entry = w.entries.find((e) => e.kind === "gate") ?? w.entries[0]!;
  const what =
    entry.state === "factory:spec-ready"
      ? { title: "Approve the plan", need: "agree the plan the factory wrote, or ask for a change.", button: "Approve the plan", after: "Approving starts the design." }
      : entry.state === "factory:design-ready"
        ? { title: "Approve the design", need: "confirm the design decisions, or ask for a change.", button: "Approve the design", after: "Approving starts the build. You are asked again only if a builder gets stuck." }
        : entry.state === "factory:epic-ready"
          ? { title: "Release to staging", need: "decide whether this goes to staging.", button: "Release to staging", after: "Releasing merges the epic onto the staging branch and deploys it there." }
          : { title: "Approve at this gate", need: "approve, or ask for a change.", button: "Approve", after: "" };
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["my-work"] }), qc.invalidateQueries({ queryKey: ["board"] })]);
  const approve = useMutation({
    mutationFn: () => api.post<{ commentUrl: string }>(`/api/epics/${w.card.epicId}/gate/approve`, { acknowledgeOpenQuestions: false }),
    onSuccess: refresh,
    onError,
  });
  const requestChanges = useMutation({
    mutationFn: (body: string) => api.post(`/api/epics/${w.card.epicId}/gate/request-changes`, { body }),
    onSuccess: () => {
      setChanges(null);
      return refresh();
    },
    onError,
  });
  const t = w.card.tasks;
  return (
    <>
      <h3>{what.title}</h3>
      <p className="need">You need to: {what.need}</p>
      <ul className="facts">
        {t.total > 0 && <li>{t.total} task{t.total === 1 ? "" : "s"}, {t.done + t.shipping} built.</li>}
        {t.tests && t.tests.total > 0 && <li>{t.tests.passed} of {t.tests.total} tests passed.</li>}
        {t.bugs && t.bugs.open > 0 && <li>{t.bugs.open} bug{t.bugs.open === 1 ? "" : "s"} still open.</li>}
        <li>{what.after}</li>
      </ul>
      {approve.isSuccess ? (
        <p className="muted">Approved. The factory has it.</p>
      ) : changes === null ? (
        <div className="decision-actions">
          <button type="button" className="primary" disabled={approve.isPending} onClick={() => approve.mutate()}>
            {approve.isPending ? "Approving…" : what.button}
          </button>
          <button
            type="button"
            onClick={() => {
              clear();
              setChanges("");
            }}
          >
            Ask for changes
          </button>
          <Link to={entry.link} className="button">
            Open the item
          </Link>
        </div>
      ) : (
        <div className="decision-reply">
          <label htmlFor={`changes-${w.card.epicId}`}>What should change?</label>
          <textarea id={`changes-${w.card.epicId}`} rows={3} value={changes} onChange={(e) => setChanges(e.target.value)} />
          <div className="decision-actions">
            <button type="button" className="primary" disabled={!changes.trim() || requestChanges.isPending} onClick={() => requestChanges.mutate(changes.trim())}>
              {requestChanges.isPending ? "Sending…" : "Send"}
            </button>
            <button type="button" onClick={() => setChanges(null)}>
              Cancel
            </button>
          </div>
          <p className="muted">Your note posts to the conversation on GitHub.</p>
        </div>
      )}
      {failure && <p className="decision-failure">{failure}</p>}
    </>
  );
}

function AnswerDecision({ item: w }: { item: WorkItem }) {
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const { failure, onError } = useFailure();
  const entry = w.entries.find((e) => e.kind === "blocked") ?? w.entries[0]!;
  const reply = useMutation({
    mutationFn: () => api.post(`/api/issues/${entry.issueId}/reply`, { body: body.trim() }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["my-work"] }), qc.invalidateQueries({ queryKey: ["board"] })]),
    onError,
  });
  return (
    <>
      <h3>The builder stopped and asked a question</h3>
      <p className="need">You need to: answer it. The builder continues once you do.</p>
      <ul className="facts">
        <li>On: {entry.title}</li>
        {entry.question && <li className="question">“{entry.question}”</li>}
        {entry.rank === 4 && <li>Nobody owns this one. Anyone may reply.</li>}
      </ul>
      {reply.isSuccess ? (
        <p className="muted">Sent. The builder continues from your answer.</p>
      ) : (
        <div className="decision-reply">
          <label htmlFor={`reply-${entry.issueId}`}>Your answer</label>
          <textarea id={`reply-${entry.issueId}`} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="decision-actions">
            <button type="button" className="primary" disabled={!body.trim() || reply.isPending} onClick={() => reply.mutate()}>
              {reply.isPending ? "Sending…" : "Reply and continue"}
            </button>
            <Link to={entry.link} className="button">
              Read the whole conversation
            </Link>
          </div>
          <p className="muted">Your reply posts to the conversation on GitHub.</p>
        </div>
      )}
      {failure && <p className="decision-failure">{failure}</p>}
    </>
  );
}

function RunDecision({ item: w }: { item: WorkItem }) {
  const cases = w.entries.filter((e) => e.kind === "task-start");
  const t = w.card.tasks.tests;
  const n = cases.length;
  return (
    <>
      <h3>Run {n} test{n === 1 ? "" : "s"}</h3>
      <p className="need">You need to: run each one and record a pass or a fail.</p>
      <ul className="facts">
        {t && t.total > 0 && (
          <li>
            {t.passed} of {t.total} have passed.{t.failed > 0 && ` ${t.failed} failed; the fix is being built and will come back for a re-test.`}
          </li>
        )}
        {cases.slice(0, 3).map((c) => (
          <li key={c.issueId}>{c.title.replace(/^test\(\d+\):\s*/, "")}</li>
        ))}
        {n > 3 && <li className="muted">and {n - 3} more</li>}
      </ul>
      <div className="decision-actions">
        <Link to={w.link} className="button primary">
          Run them
        </Link>
        <Link to={`/work/${w.card.epicId}`} className="button">
          Open the item
        </Link>
      </div>
    </>
  );
}
