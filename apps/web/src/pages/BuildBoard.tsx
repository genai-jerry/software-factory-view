import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { TaskStartGate } from "../components/Approve.js";
import { StartRoleButton } from "../components/NextStep.js";
import { namesOf, plainTitle } from "../lib/labels.js";
import type { EpicWorkspace, IssuePeekData, NextStep } from "../types.js";

/**
 * Build — the tasks, and the one thing a person may be asked (redesign
 * board 6). Every pull request, review and merge stays behind the words:
 * a task is waiting, being written, being reviewed, being tested, done, or
 * stopped with a question. The question is answered here; a task that
 * still needs a start approval gets its button here — and so does a task
 * that is written and waits for a person to start its review or its test:
 * in-review and in-test start nothing on their own (FACTORY.md §3), and
 * until this board said so it read as "the factory has it".
 */

type Task = EpicWorkspace["tasks"][number];

export type TaskWord =
  | "done"
  | "writing"
  | "reviewing"
  | "testing"
  | "merging"
  | "stopped"
  | "waiting-start"
  | "waiting-review"
  | "waiting-test"
  | "waiting-merge"
  | "waiting-on"
  | "queued";

/** The words this board uses for the role a person starts. */
const ROLE_WORD: Record<string, { word: TaskWord; noun: string; button: string }> = {
  reviewer: { word: "waiting-review", noun: "review", button: "Start the review" },
  qa: { word: "waiting-test", noun: "test", button: "Start the test" },
  // The Release Manager's first phase: the task's pull request onto the
  // epic branch (§6b). "Merge" is the reader's word for it.
  release: { word: "waiting-merge", noun: "merge", button: "Start the merge" },
};

const ROLE_START_WORDS: TaskWord[] = ["waiting-review", "waiting-test", "waiting-merge"];
const IN_FLIGHT_WORDS: TaskWord[] = ["writing", "reviewing", "testing", "merging"];

/**
 * The next role is one a person has to start, and nobody has: not expedited
 * (then the factory starts it), not already running (the run marker is on).
 */
function roleStartOf(t: Task): { word: TaskWord; noun: string; button: string } | null {
  const step = t.nextStep;
  if (!step?.startRole || !step.waitsOnPerson || step.automatic || t.running) return null;
  return ROLE_WORD[step.startRole] ?? null;
}

/** The same step with this board's words on the button. */
function roleStep(t: Task): NextStep {
  const r = roleStartOf(t);
  return r ? { ...t.nextStep, startLabel: r.button } : t.nextStep;
}

export function taskWord(t: Task): { word: TaskWord; text: string } {
  const s = t.state ?? "";
  if (!t.open || s === "factory:on-epic" || s === "factory:in-staging" || s === "factory:deployed") return { word: "done", text: "Done" };
  if (s === "factory:blocked") return { word: "stopped", text: "Stopped · asks you" };
  if (t.running && t.runningRole === "reviewer") return { word: "reviewing", text: "Being reviewed" };
  if (t.running && t.runningRole === "qa") return { word: "testing", text: "Being tested" };
  if (t.running && t.runningRole === "release") return { word: "merging", text: "Being merged" };
  if (t.running) return { word: "writing", text: "Being written" };
  const role = roleStartOf(t);
  if (role && (s === "factory:in-review" || s === "factory:in-test" || s === "factory:ready-to-ship")) {
    return { word: role.word, text: `Waiting for you to start the ${role.noun}` };
  }
  if (s === "factory:in-review") return { word: "reviewing", text: "Waiting for review" };
  if (s === "factory:in-test") return { word: "testing", text: "Waiting for test" };
  // Green, and its merge onto the epic branch is the factory's (expedite).
  if (s === "factory:ready-to-ship") return { word: "merging", text: "Waiting for the merge" };
  if (s === "factory:in-progress") return { word: "writing", text: "Being written" };
  const after = t.blockedBy.filter((d) => d.open);
  if (s === "factory:ready" && t.approvable) return { word: "waiting-start", text: "Waiting for a start" };
  // The chip stays short so every row lines up; the names go under the title.
  if (after.length > 0) return { word: "waiting-on", text: after.length === 1 ? "Waiting on another task" : `Waiting on ${after.length} tasks` };
  return { word: "queued", text: "Waiting" };
}

export function BuildBoard({ data }: { data: EpicWorkspace }) {
  const tasks = data.tasks.filter((t) => t.kind !== "test").sort((a, b) => a.number - b.number);
  const words = tasks.map((t) => ({ t, ...taskWord(t) }));
  const built = words.filter((w) => w.word === "done").length;
  const inFlight = words.filter((w) => IN_FLIGHT_WORDS.includes(w.word)).length;
  const stopped = words.filter((w) => w.word === "stopped");
  const starts = words.filter((w) => w.word === "waiting-start");
  const reviews = words.filter((w) => w.word === "waiting-review");
  const tests = words.filter((w) => w.word === "waiting-test");
  const merges = words.filter((w) => w.word === "waiting-merge");
  const toStart = starts.length + reviews.length + tests.length + merges.length;
  const waiting = words.filter((w) => w.word === "waiting-on" || w.word === "queued").length;
  const running = tasks.filter((t) => t.running && t.open);

  return (
    <>
      {stopped.map((w) => (
        <NeedsAnswer key={w.t.id} task={w.t} epicId={data.epic.id} />
      ))}

      <section className="card" aria-labelledby="tasks">
        <div className="spread">
          <h2 id="tasks">
            Tasks <span className="muted">{built} of {tasks.length} built</span>
          </h2>
          <span className="muted">
            {[inFlight > 0 && `${inFlight} in flight`, stopped.length > 0 && `${stopped.length} stopped`, toStart > 0 && `${toStart} to start`, waiting > 0 && `${waiting} waiting`]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        {tasks.length === 0 && <p className="muted">No tasks yet. The Planner opens them when the plan is approved.</p>}
        <ol className="task-list">
          {words.map(({ t, word, text }, i) => (
            <li key={t.id} className={`task-row ${word}`}>
              <span className="task-n">{i + 1}</span>
              <span className="task-title">
                {plainTitle(t.title)}
                {word === "waiting-on" && <span className="task-after">After {namesOf(t.blockedBy.filter((d) => d.open))}</span>}
              </span>
              <span className={`stage-chip ${word === "done" ? "done" : word === "stopped" ? "halt" : word === "waiting-start" || ROLE_START_WORDS.includes(word) ? "decide" : IN_FLIGHT_WORDS.includes(word) ? "wait" : ""}`}>
                {text}
              </span>
              {word === "waiting-start" && (
                <span className="task-start">
                  <TaskStartGate epicId={data.epic.id} taskId={t.id} number={t.number} startGate={data.startGate} status={t.startStatus} />
                </span>
              )}
              {ROLE_START_WORDS.includes(word) && (
                <span className="task-start">
                  <StartRoleButton issueId={t.id} step={roleStep(t)} />
                </span>
              )}
            </li>
          ))}
        </ol>
        <p className="muted">Each task is written, reviewed and tested by the factory before it counts as done. You see only the result.</p>
      </section>

      <section className="card">
        <h2>Your decision</h2>
        {stopped.length > 0 ? (
          <p className="need">You need to: answer the question{stopped.length === 1 ? "" : "s"} above. Nothing else waits on you here.</p>
        ) : data.expedite.on ? (
          <p className="need">Nothing waits on you. The factory runs it through to the staging release, and asks you once: to release it to staging.</p>
        ) : toStart > 0 ? (
          <p className="need">You need to: start {startLine(starts.length, reviews.length, tests.length, merges.length)}, above.</p>
        ) : (
          <p className="need">Nothing waits on you. The factory has it.</p>
        )}
        {data.epic.open && stopped.length === 0 && <RunThrough epicId={data.epic.id} expedite={data.expedite} toStart={toStart} />}
        <p className="muted">
          {data.systemTests.runOn === "staging"
            ? "When every task is merged, you are asked to release the item to staging. The tests run there."
            : "When the build finishes, the tests are run. You are asked again at the release."}
        </p>
      </section>

      {running.length > 0 && (
        <section className="card">
          <h2>Happening now</h2>
          <ul className="facts">
            {running.map((t) => (
              <li key={t.id}>
                {roleName(t.runningRole)} on task {t.number}.{" "}
                {t.runId && (
                  <Link to={`/runs/${t.runId}`} className="muted">
                    What it is doing
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * One switch instead of a start per step: `factory:expedite` on the epic
 * (FACTORY.md §4a). From then on the factory starts every review, test and
 * merge itself and the tasks that wait on them, and stops once — at the
 * release to staging, which stays the reader's. The engineers' view calls it
 * expedite; here it is said by what it does.
 */
function RunThrough({ epicId, expedite, toStart }: { epicId: string; expedite: EpicWorkspace["expedite"]; toStart: number }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const flip = useMutation({
    mutationFn: (on: boolean) => api.post<{ ok: boolean; on: boolean }>(`/api/epics/${epicId}/expedite`, { on }),
    onSuccess: () => {
      setConfirming(false);
      setFailure(null);
      void qc.invalidateQueries({ queryKey: ["epic", epicId] });
      void qc.invalidateQueries({ queryKey: ["my-work"] });
    },
    onError: (e) => setFailure(e instanceof ApiError ? e.message : "That did not go through. Try again."),
  });
  if (expedite.on) {
    return (
      <div className="run-through">
        <button type="button" disabled={!expedite.available || flip.isPending} onClick={() => flip.mutate(false)}>
          {flip.isPending ? "Stopping…" : "Ask me at each step instead"}
        </button>
        {failure && <p className="decision-failure">{failure}</p>}
      </div>
    );
  }
  if (!expedite.available) return null;
  return (
    <div className="run-through">
      {confirming ? (
        <div className="decision-reply">
          <p>
            From here the factory starts each step itself: {toStart > 0 ? `the ${toStart === 1 ? "start" : `${toStart} starts`} above, ` : ""}every review, test and
            merge, and the tasks that wait on them. It stops once, at the release to staging, and asks you. Nothing reaches production without you.
          </p>
          <div className="decision-actions">
            <button type="button" className="primary" disabled={flip.isPending} onClick={() => flip.mutate(true)}>
              {flip.isPending ? "Starting…" : "Run it to staging"}
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Not now
            </button>
          </div>
        </div>
      ) : (
        <div className="decision-actions">
          <button type="button" onClick={() => setConfirming(true)}>
            Let the factory run it to staging
          </button>
        </div>
      )}
      {failure && <p className="decision-failure">{failure}</p>}
    </div>
  );
}

/** "the review on 3 tasks and the merge on 1 task" — or the build starts. */
function startLine(builds: number, reviews: number, tests: number, merges = 0): string {
  const parts: string[] = [];
  if (builds > 0) parts.push(builds === 1 ? "the task that waits for a start" : `${builds} tasks that wait for a start`);
  if (reviews > 0) parts.push(`the review on ${reviews === 1 ? "1 task" : `${reviews} tasks`}`);
  if (tests > 0) parts.push(`the test on ${tests === 1 ? "1 task" : `${tests} tasks`}`);
  if (merges > 0) parts.push(`the merge on ${merges === 1 ? "1 task" : `${merges} tasks`}`);
  return parts.join(" and ");
}

function roleName(role: string | null | undefined): string {
  const names: Record<string, string> = { implementer: "Builder", reviewer: "Reviewer", qa: "Tester", release: "Release manager", dispatch: "Dispatcher" };
  return role ? (names[role] ?? role) : "The factory";
}

function NeedsAnswer({ task, epicId }: { task: Task; epicId: string }) {
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const peek = useQuery({ queryKey: ["peek", task.id], queryFn: () => api.get<IssuePeekData>(`/api/issues/${task.id}/peek`) });
  const reply = useMutation({
    mutationFn: () => api.post(`/api/issues/${task.id}/reply`, { body: body.trim() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["epic", epicId] }),
    onError: (e) => setFailure(e instanceof ApiError ? e.message : "That did not go through. Try again."),
  });
  const questions = peek.data?.blocked?.questions ?? [];
  const question = questions[0] ?? peek.data?.blocked?.question ?? null;
  const several = questions.length > 1;
  return (
    <section className="card needs-answer" aria-labelledby={`answer-${task.id}`}>
      <div className="spread">
        <h2 id={`answer-${task.id}`}>Needs an answer</h2>
        <span className="muted">Task {task.number}</span>
      </div>
      <p className="need">You need to: answer the factory's question{several ? "s" : ""}. It continues once you do.</p>
      {several ? (
        <ol className="question" aria-label="Questions for you">
          {questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ol>
      ) : question ? (
        <blockquote className="question">{question}</blockquote>
      ) : (
        <p className="muted">{peek.isLoading ? "Reading the question…" : "The factory stopped; its question is in the conversation."}</p>
      )}
      {reply.isSuccess ? (
        <p className="muted">Sent. The factory continues from your answer.</p>
      ) : (
        <div className="decision-reply">
          <label htmlFor={`reply-${task.id}`}>Your answer</label>
          <textarea id={`reply-${task.id}`} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="decision-actions">
            <button type="button" className="primary" disabled={!body.trim() || reply.isPending} onClick={() => reply.mutate()}>
              {reply.isPending ? "Sending…" : "Reply and continue"}
            </button>
            <Link to={`/epics/${epicId}?tab=threads`} className="button">
              Read the whole conversation
            </Link>
          </div>
          <p className="muted">Your reply posts to the conversation on GitHub.</p>
        </div>
      )}
      {failure && <p className="decision-failure">{failure}</p>}
    </section>
  );
}
