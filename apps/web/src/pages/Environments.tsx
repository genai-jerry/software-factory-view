import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { RepoChip } from "../components/RepoChip.js";
import { Sheet } from "../components/Sheet.js";
import { useFocus } from "../lib/filter.js";
import { lengthWords } from "../lib/runs.js";
import type { EnvCard, EnvironmentsView, EnvLane, EnvSession, EnvTurn } from "../types.js";
import { localTimesText } from "../lib/localTimes.js";

/**
 * Environments: where the Claude sessions run. The page reads left to right,
 * the way work moves. Tasks are built in their own environments, merge into
 * their epic's, and epics go onto staging one at a time. Each environment
 * runs one session at a time; the dot on a card says what it is doing.
 */

/** Idle task environments shown before "N more". */
const IDLE_SHOWN = 2;

export type EnvState = "running" | "waiting" | "failed" | "idle";

const FAILED = new Set(["error", "timeout", "no_op"]);

export function envState(card: EnvCard): EnvState {
  if (card.active) return card.active.state === "running" || card.active.state === "starting" ? "running" : "waiting";
  if (card.queue.length) return "waiting";
  if (card.notes[0] && FAILED.has(card.notes[0].outcome)) return "failed";
  return "idle";
}

export function outcomeShort(outcome: string): string {
  switch (outcome) {
    case "success":
      return "done";
    case "timeout":
      return "ran out of time";
    case "no_op":
      return "changed nothing";
    case "error":
      return "failed";
    default:
      return outcome || "finished";
  }
}

/** "4 min" since an ISO time, or null. */
function since(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : lengthWords(Math.max(0, Math.round((now - t) / 1000)));
}

/** "14:05", "Yesterday 14:05" or "4 Nov 14:05", in the reader's time. */
export function clockWords(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === today.toDateString()) return time;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/** What the run holding an environment is doing, in one line. */
function turnLine(turn: EnvTurn, card: EnvCard, now: number): string {
  const on = turn.title && turn.title !== card.title ? ` on “${turn.title}”` : "";
  if (turn.state === "waiting for a session") return `${turn.role}${on} · waiting for a free session`;
  const took = since(turn.since, now);
  return `${turn.role}${on} · running${took ? ` · ${took}` : ""}`;
}

function lastLine(card: EnvCard, now: number): string | null {
  const n = card.notes[0];
  if (!n) return card.lastUsedAt ? `Last used ${clockWords(card.lastUsedAt, now)}` : null;
  return `Last: ${n.role}, ${clockWords(n.at, now)}, ${outcomeShort(n.outcome)}`;
}

function EnvCardView({ card, now, onOpen, wide }: { card: EnvCard; now: number; onOpen: (c: EnvCard) => void; wide?: boolean }) {
  const state = envState(card);
  const kindWord = card.kind === "staging" ? "STAGING · ONE AT A TIME" : card.kind === "epic" ? "EPIC" : card.kind === "task" ? "TASK" : "ISSUE";
  const memory = card.notes[0] && localTimesText(card.notes[0].summary, card.notes[0].at);
  return (
    <button
      type="button"
      className={`env-card env-${state}${wide ? " env-wide" : ""}`}
      onClick={() => onOpen(card)}
      aria-label={`${card.title}: ${stateWord(state)}. Open what this environment remembers.`}
    >
      <span className="env-kind">{kindWord}</span>
      <span className="env-title">{card.title}</span>
      <span className="env-line">
        <span className="env-dot" aria-hidden="true" />
        {card.active ? turnLine(card.active, card, now) : card.queue.length ? `Waiting · ${card.queue.length} queued` : stateWord(state)}
      </span>
      {card.kind !== "staging" && card.queue.length > 0 && (
        <span className="env-sub">Next: {card.queue.map((q) => q.role).join(", then ")}</span>
      )}
      {card.kind === "staging" && <StagingQueue card={card} />}
      {!card.active && lastLine(card, now) && <span className="env-sub">{lastLine(card, now)}</span>}
      {memory && (
        <span className="env-mem">
          <b>Remembers:</b> {memory.length > 150 ? `${memory.slice(0, 150).trimEnd()}…` : memory}
        </span>
      )}
    </button>
  );
}

function stateWord(state: EnvState): string {
  return state === "running" ? "Running" : state === "waiting" ? "Waiting" : state === "failed" ? "Idle · last run failed" : "Idle";
}

/** Staging's line: who is on it now, then who is next, in order. */
function StagingQueue({ card }: { card: EnvCard }) {
  const line = [...(card.active ? [card.active] : []), ...card.queue];
  if (line.length === 0) return <span className="env-sub">Nothing waiting to go onto staging.</span>;
  return (
    <ol className="env-queue" aria-label="Order onto staging">
      {line.map((t, i) => (
        <li key={`${t.runId ?? i}`}>
          <span className="env-queue-n">{i + 1}</span>
          {t.title ?? t.role}
          {i === 0 && card.active ? <b> · now</b> : <span className="muted"> · waiting</span>}
        </li>
      ))}
    </ol>
  );
}

function SessionMeter({ sessions }: { sessions: NonNullable<EnvironmentsView["sessions"]> }) {
  const free = Math.max(0, sessions.total - sessions.inUse.length);
  const label = (s: EnvSession) => (s.staging ? `${s.role} · staging` : s.title ? `${s.role} · ${s.title}` : s.role);
  return (
    <div className="env-sessions" aria-label={`${sessions.inUse.length} of ${sessions.total} Claude sessions in use`}>
      <span className="muted">Claude sessions</span>
      {sessions.inUse.map((s, i) =>
        s.runId ? (
          <Link key={s.runId} to={`/runs/${s.runId}`} className="env-slot on" title={label(s)}>
            {label(s)}
          </Link>
        ) : (
          <span key={`other-${i}`} className="env-slot on" title={label(s)}>
            {label(s)}
          </span>
        ),
      )}
      {Array.from({ length: free }, (_, i) => (
        <span key={`free-${i}`} className="env-slot">
          free
        </span>
      ))}
      {sessions.waiting.length > 0 && (
        <span className="env-waiting-sum">
          {sessions.waiting.length} waiting for a free session
        </span>
      )}
    </div>
  );
}

function TasksCell({ lane, now, onOpen }: { lane: EnvLane; now: number; onOpen: (c: EnvCard) => void }) {
  const [all, setAll] = useState(false);
  let idle = 0;
  const shown = lane.tasks.filter((t) => all || envState(t) !== "idle" || idle++ < IDLE_SHOWN);
  const hidden = lane.tasks.length - shown.length;
  return (
    <div className="env-tasks">
      {shown.map((t) => (
        <EnvCardView key={t.id} card={t} now={now} onOpen={onOpen} />
      ))}
      {hidden > 0 && (
        <button type="button" className="env-pill" onClick={() => setAll(true)}>
          {hidden} more idle
        </button>
      )}
      {lane.tasksTotal > 0 && (
        <span className="env-pill static">
          {lane.tasksMerged === lane.tasksTotal ? `All ${lane.tasksTotal} tasks merged into the epic` : `${lane.tasksMerged} of ${lane.tasksTotal} tasks merged into the epic`}
        </span>
      )}
    </div>
  );
}

function EnvSheet({ card, onClose, now }: { card: EnvCard; onClose: () => void; now: number }) {
  const link = card.epicId ? `/epics/${card.epicId}` : null;
  return (
    <Sheet title={card.kind === "staging" ? `Staging · ${card.repo}` : card.title} onClose={onClose}>
      <div className="env-sheet">
        <p className="muted">
          {card.kind === "staging"
            ? "The one environment where releases go onto staging, one at a time."
            : card.kind === "epic"
              ? "The epic's own environment. Its roles work here, and each task's release merges into the epic from here."
              : "This task's own environment: building, reviewing and testing happen here."}{" "}
          It runs one Claude session at a time and is reset to GitHub before every run.
        </p>
        {card.active && (
          <p>
            <strong>Now:</strong> {turnLine(card.active, card, now)}
            {card.active.runId && (
              <>
                {" "}
                · <Link to={`/runs/${card.active.runId}`}>open the run</Link>
              </>
            )}
          </p>
        )}
        {card.queue.length > 0 && (
          <p>
            <strong>Waiting:</strong> {card.queue.map((q) => (q.title && q.title !== card.title ? `${q.role} on “${q.title}”` : q.role)).join(", then ")}
          </p>
        )}
        {link && (
          <p>
            <Link to={link}>Open the epic</Link>
          </p>
        )}
        <h3>What this environment remembers</h3>
        {card.notes.length === 0 ? (
          <p className="muted">Nothing yet. After each run, the factory adds what Claude did and what is still open; the next run here reads it first.</p>
        ) : (
          <ul className="env-timeline">
            {card.notes.map((n, i) => (
              <li key={`${n.runId ?? i}`} className={FAILED.has(n.outcome) ? "bad" : ""}>
                <span className="env-when">
                  {clockWords(n.at, now)} · {n.role}
                  {n.title && n.title !== card.title ? ` on “${n.title}”` : ""} · {outcomeShort(n.outcome)}
                  {n.runId && (
                    <>
                      {" · "}
                      <Link to={`/runs/${n.runId}`}>run</Link>
                    </>
                  )}
                </span>
                <span className="env-note">{localTimesText(n.summary, n.at) || "No closing summary."}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          <RepoChip fullName={card.repo} />
        </p>
      </div>
    </Sheet>
  );
}

export function EnvironmentsPage() {
  const focus = useFocus();
  const q = useQuery({
    queryKey: ["environments", focus.key],
    queryFn: () => api.get<EnvironmentsView>(`/api/environments${focus.qs}`),
    refetchInterval: 5_000,
  });
  const [open, setOpen] = useState<EnvCard | null>(null);
  const now = q.dataUpdatedAt || Date.now();
  const data = q.data;
  const lanes = data?.lanes ?? [];
  const staging = data?.staging ?? [];
  const live = data ? [...staging, ...lanes.flatMap((l) => [l.epic, ...l.tasks]), ...data.other].filter((c): c is EnvCard => Boolean(c)) : [];
  const queued = live.reduce((n, c) => n + c.queue.length, 0);
  // Keep the open sheet current as the board refreshes.
  const openCard = open ? (live.find((c) => c.id === open.id) ?? open) : null;

  return (
    <div className="env-page">
      <h1>Environments</h1>
      <p className="muted">
        Where the Claude sessions run. Tasks are built in their own environments, merge into their epic, and epics go onto staging one at a time. Each
        environment runs one session at a time.
      </p>

      {q.isLoading && <p className="muted">Reading…</p>}
      {q.isError && <p className="banner error">Could not read the environments.</p>}
      {data && !data.available && (
        <p className="banner info">The factory's orchestrator does not list its environments yet. It needs the build environments update deployed.</p>
      )}

      {data?.available && (
        <section className="card env-board" aria-label="Build environments">
          <div className="env-top">
            {data.sessions && <SessionMeter sessions={data.sessions} />}
            {queued > 0 && <span className="env-waiting-sum">{queued} waiting for an environment</span>}
          </div>

          {lanes.length === 0 && staging.length === 0 && <p className="muted">No environments yet. One appears when the factory first runs on a piece of work.</p>}

          {(lanes.length > 0 || staging.length > 0) && (
            <div className="env-flow" style={{ ["--lanes" as string]: Math.max(1, lanes.length) }}>
              <div className="env-colhead">TASKS</div>
              <div aria-hidden="true" />
              <div className="env-colhead">EPICS</div>
              <div aria-hidden="true" />
              <div className="env-colhead">STAGING</div>

              {lanes.map((lane, i) => (
                <LaneRow key={lane.ref} lane={lane} row={i + 2} now={now} onOpen={setOpen} />
              ))}

              <div className="env-staging" style={{ gridRow: `2 / span ${Math.max(1, lanes.length)}` }}>
                {staging.length === 0 ? (
                  <p className="muted">No staging environment yet. It appears with the first release onto staging.</p>
                ) : (
                  staging.map((s) => <EnvCardView key={s.id} card={s} now={now} onOpen={setOpen} wide />)
                )}
              </div>
            </div>
          )}

          <div className="env-legend" aria-label="What the dots mean">
            <span>
              <span className="env-dot running" /> Running
            </span>
            <span>
              <span className="env-dot waiting" /> Waiting for a session, or for its turn
            </span>
            <span>
              <span className="env-dot failed" /> Idle, and its last run failed
            </span>
            <span>
              <span className="env-dot idle" /> Idle
            </span>
          </div>
        </section>
      )}

      {data?.available && data.other.length > 0 && (
        <section className="card" aria-label="Other work">
          <h2>Other work</h2>
          <div className="env-tasks">
            {data.other.map((c) => (
              <EnvCardView key={c.id} card={c} now={now} onOpen={setOpen} />
            ))}
          </div>
        </section>
      )}

      {openCard && <EnvSheet card={openCard} now={now} onClose={() => setOpen(null)} />}
    </div>
  );
}

function LaneRow({ lane, row, now, onOpen }: { lane: EnvLane; row: number; now: number; onOpen: (c: EnvCard) => void }) {
  return (
    <>
      <div className="env-lane-tasks" style={{ gridRow: row }}>
        <TasksCell lane={lane} now={now} onOpen={onOpen} />
      </div>
      <div className="env-arrow env-arrow-in" style={{ gridRow: row }} aria-hidden="true">
        →
      </div>
      <div className="env-lane-epic" style={{ gridRow: row }}>
        {lane.epic ? (
          <EnvCardView card={lane.epic} now={now} onOpen={onOpen} />
        ) : (
          <div className="env-card env-idle env-ghost">
            <span className="env-kind">EPIC</span>
            <span className="env-title">{lane.title}</span>
            <span className="env-sub">No environment of its own yet.</span>
          </div>
        )}
      </div>
      <div className="env-arrow env-arrow-out" style={{ gridRow: row }} aria-hidden="true">
        →
      </div>
    </>
  );
}
