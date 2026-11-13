import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { RepoChip } from "../components/RepoChip.js";
import { Sheet } from "../components/Sheet.js";
import { useFocus } from "../lib/filter.js";
import { lengthWords } from "../lib/runs.js";
import { useIsPhone } from "../lib/screens.js";
import type { EnvCard, EnvironmentsView, EnvLane, EnvMerge, EnvPull, EnvSession, EnvTurn } from "../types.js";
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

/** "claude-opus-5-5" → "Opus 5.5": the model in the words a person says it. */
export function modelName(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(model);
  if (!m) return model;
  const family = m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase();
  return `${family} ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ""}`;
}

/** What the run holding an environment is doing, in one line. */
function turnLine(turn: EnvTurn, card: EnvCard, now: number): string {
  const on = turn.title && turn.title !== card.title ? ` on “${turn.title}”` : "";
  const model = modelName(turn.model);
  const who = `${turn.role}${model ? ` (${model})` : ""}`;
  if (turn.state === "waiting for a session") return `${who}${on} · waiting for a free session`;
  const took = since(turn.since, now);
  return `${who}${on} · running${took ? ` · ${took}` : ""}`;
}

function lastLine(card: EnvCard, now: number): string | null {
  const n = card.notes[0];
  if (!n) return card.lastUsedAt ? `Last used ${clockWords(card.lastUsedAt, now)}` : null;
  const model = modelName(n.model);
  return `Last: ${n.role}${model ? ` (${model})` : ""}, ${clockWords(n.at, now)}, ${outcomeShort(n.outcome)}`;
}

function EnvCardView({ card, now, onOpen, wide }: { card: EnvCard; now: number; onOpen: (c: EnvCard) => void; wide?: boolean }) {
  const state = envState(card);
  const kindWord = card.kind === "staging" ? "STAGING · ONE AT A TIME" : card.kind === "epic" ? "EPIC" : card.kind === "task" ? "TASK" : "ISSUE";
  const memory = card.notes[0] && localTimesText(card.notes[0].summary, card.notes[0].at);
  return (
    <div className={`env-card-wrap${wide ? " env-wide" : ""}`}>
      <button
        type="button"
        className={`env-card env-${state}${wide ? " env-wide" : ""}`}
        onClick={() => onOpen(card)}
        aria-label={`${card.title}: ${stateWord(state)}. Open what this environment remembers.`}
      >
        <span className="env-kind">
          {kindWord}
          {card.kind !== "epic" && (
            <RepoChip fullName={card.repo} title={card.kind === "staging" ? `The staging branch of ${card.repo}` : `Built in ${card.repo}`} />
          )}
        </span>
        <span className="env-title">{card.title}</span>
        <span className="env-line">
          <span className="env-dot" aria-hidden="true" />
          {card.active ? turnLine(card.active, card, now) : card.queue.length ? `Waiting · ${card.queue.length} queued` : stateWord(state)}
        </span>
        {card.kind !== "staging" && card.queue.length > 0 && (
          <span className="env-sub">Next: {card.queue.map((q) => q.role).join(", then ")}</span>
        )}
        {card.kind === "staging" && <StagingQueue card={card} />}
        {card.kind === "staging" && <OnStaging card={card} />}
        {!card.active && lastLine(card, now) && <span className="env-sub">{lastLine(card, now)}</span>}
        {memory && (
          <span className="env-mem">
            <b>Remembers:</b> {memory.length > 150 ? `${memory.slice(0, 150).trimEnd()}…` : memory}
          </span>
        )}
        {card.notes[0]?.merged?.length ? <span className="env-merged">{mergedWords(card.notes[0].merged)}</span> : null}
      </button>
      {card.pulls?.length > 0 && <Pulls card={card} now={now} />}
    </div>
  );
}

/**
 * What a run merged, by branch, without numbers (the card names work by its
 * title): "Merged 1 pull request onto factory/epic-193" — or two branches,
 * "Merged 2 pull requests onto factory/epic-193, 1 onto staging".
 */
export function mergedWords(merged: EnvMerge[]): string {
  const by = new Map<string, number>();
  for (const m of merged) by.set(m.baseRef, (by.get(m.baseRef) ?? 0) + 1);
  const parts = [...by].map(([branch, n], i) => (i === 0 ? `${n} pull request${n === 1 ? "" : "s"} onto ${branch}` : `${n} onto ${branch}`));
  return `Merged ${parts.join(", ")}`;
}

/** How many of a card's pull requests merged, and the words for the icon. */
function pullsLabel(card: EnvCard): string {
  const merged = card.pulls.filter((p) => p.state === "merged").length;
  const open = card.pulls.filter((p) => p.state === "open").length;
  const parts = [merged ? `${merged} merged` : "", open ? `${open} open` : ""].filter(Boolean);
  return `Pull requests of ${card.title}: ${parts.join(", ") || `${card.pulls.length} closed`}`;
}

/** The word for a pull request's state, read beside its title. */
function pullState(p: EnvPull, now: number): string {
  if (p.state === "merged") return `merged ${clockWords(p.mergedAt, now)}`.trim();
  return p.state === "open" ? "open" : "closed, not merged";
}

/**
 * The small pull-request icon on a card, with how many merged; it opens a
 * popup listing every pull request behind the card, each linking to GitHub.
 * It sits beside the card's own button (a button inside a button is not a
 * thing), so the card still opens what the environment remembers.
 *
 * On a phone the list opens in the bottom sheet instead (epic #178, design
 * D5): a popover pinned to a card's corner can run off a 360px screen. The
 * sheet closes on Escape and returns focus by itself, so the listeners below
 * serve the popover only.
 */
function PullList({ card, now }: { card: EnvCard; now: number }) {
  return (
    <ul className="env-pulls-list">
      {card.pulls.map((p) => (
        <li key={p.number} className={`env-pull is-${p.state}`}>
          <a href={p.url} target="_blank" rel="noreferrer" className="env-pull-link">
            <span className="env-pull-dot" aria-hidden="true" />
            <span className="env-pull-num">#{p.number}</span>
            <span className="env-pull-title">{p.title}</span>
          </a>
          <span className="env-pull-meta">
            {pullState(p, now)} · {p.headRef} → {p.baseRef}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Pulls({ card, now }: { card: EnvCard; now: number }) {
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const asPopover = open && !phone;
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const merged = card.pulls.filter((p) => p.state === "merged").length;
  useEffect(() => {
    if (!asPopover) return;
    const away = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [asPopover]);
  return (
    <div className="env-pulls" ref={wrap}>
      <button
        type="button"
        ref={button}
        className={`env-pulls-btn${open ? " is-open" : ""}`}
        aria-label={pullsLabel(card)}
        aria-expanded={open}
        aria-controls={asPopover ? popId : undefined}
        title={pullsLabel(card)}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
          <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
        </svg>
        <span className="env-pulls-n">{merged || card.pulls.length}</span>
      </button>
      {open && !phone && (
        <div className="env-pulls-pop" role="dialog" id={popId} aria-label={`Pull requests · ${card.title}`}>
          <PullList card={card} now={now} />
        </div>
      )}
      {open && phone && (
        <Sheet title={`Pull requests · ${card.title}`} onClose={() => setOpen(false)}>
          <PullList card={card} now={now} />
        </Sheet>
      )}
    </div>
  );
}

function stateWord(state: EnvState): string {
  return state === "running" ? "Running" : state === "waiting" ? "Waiting" : state === "failed" ? "Idle · last run failed" : "Idle";
}

/**
 * Quiet hues that read on both themes, ordered so neighbours differ most.
 * Epics take them in epic-number order, so two on the page never share one
 * (up to eight) and an epic keeps its hue while the set of epics holds.
 */
const LANE_HUES = ["#4fb3a9", "#d9a441", "#a17fe0", "#e0709a", "#5aa7d6", "#9bbf5a", "#e5895a", "#c7b8a3"];

export function laneColors(refs: string[]): Map<string, string> {
  const num = (r: string) => Number(r.slice(r.lastIndexOf("#") + 1)) || 0;
  const sorted = [...new Set(refs)].sort((a, b) => num(a) - num(b) || a.localeCompare(b));
  return new Map(sorted.map((r, i) => [r, LANE_HUES[i % LANE_HUES.length]!]));
}

const LaneColorCtx = createContext<Map<string, string>>(new Map());
const useLaneColor = () => {
  const colors = useContext(LaneColorCtx);
  return (ref: string) => colors.get(ref) ?? "var(--border)";
};

/** The epics merged onto this staging, each in its lane's colour. */
function OnStaging({ card }: { card: EnvCard }) {
  const laneColor = useLaneColor();
  if (!card.onStaging?.length) return null;
  return (
    <span className="env-onstaging">
      <span className="env-onstaging-head">Merged onto staging</span>
      {card.onStaging.map((e) => (
        <span key={e.ref} className="env-onstaging-item">
          <span className="env-swatch" style={{ background: laneColor(e.ref) }} aria-hidden="true" />
          {e.title}
        </span>
      ))}
    </span>
  );
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
  const label = (s: EnvSession) => {
    const model = modelName(s.model);
    const role = model ? `${s.role} (${model})` : s.role;
    return s.staging ? `${role} · staging` : s.title ? `${role} · ${s.title}` : role;
  };
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
                  {modelName(n.model) ? ` (${modelName(n.model)})` : ""}
                  {n.title && n.title !== card.title ? ` on “${n.title}”` : ""} · {outcomeShort(n.outcome)}
                  {n.runId && (
                    <>
                      {" · "}
                      <Link to={`/runs/${n.runId}`}>run</Link>
                    </>
                  )}
                </span>
                <span className="env-note">{localTimesText(n.summary, n.at) || "No closing summary."}</span>
                {n.merged && n.merged.length > 0 && (
                  <span className="env-merged">
                    Merged:{" "}
                    {n.merged.map((m, j) => (
                      <span key={m.number}>
                        {j > 0 && ", "}
                        <a href={m.url} target="_blank" rel="noreferrer" title={m.title}>
                          #{m.number}
                        </a>{" "}
                        → {m.baseRef}
                      </span>
                    ))}
                  </span>
                )}
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
  const colors = useMemo(
    () => laneColors([...lanes.map((l) => l.ref), ...staging.flatMap((st) => (st.onStaging ?? []).map((e) => e.ref))]),
    [lanes, staging],
  );
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
            <LaneColorCtx.Provider value={colors}>
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
            </LaneColorCtx.Provider>
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
  const laneColor = useLaneColor();
  return (
    <>
      <div className="env-lane-tasks" style={{ gridRow: row, ["--lane" as string]: laneColor(lane.ref) }}>
        <TasksCell lane={lane} now={now} onOpen={onOpen} />
      </div>
      <div className="env-arrow env-arrow-in" style={{ gridRow: row }} aria-hidden="true">
        →
      </div>
      <div className="env-lane-epic" style={{ gridRow: row, ["--lane" as string]: laneColor(lane.ref) }}>
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
