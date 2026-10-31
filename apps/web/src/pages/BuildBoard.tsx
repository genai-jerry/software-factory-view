import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { TaskStartGate } from "../components/Approve.js";
import type { EpicWorkspace, IssuePeekData } from "../types.js";

/**
 * Build — the tasks, and the one thing a person may be asked (redesign
 * board 6). Every pull request, review and merge stays behind the words:
 * a task is waiting, being written, being reviewed, being tested, done, or
 * stopped with a question. The question is answered here; a task that
 * still needs a start approval gets its button here.
 */

type Task = EpicWorkspace["tasks"][number];

export type TaskWord = "done" | "writing" | "reviewing" | "testing" | "stopped" | "waiting-start" | "waiting-on" | "queued";

export function taskWord(t: Task): { word: TaskWord; text: string } {
  const s = t.state ?? "";
  if (!t.open || s === "factory:on-epic" || s === "factory:ready-to-ship" || s === "factory:deployed") return { word: "done", text: "Done" };
  if (s === "factory:blocked") return { word: "stopped", text: "Stopped · asks you" };
  if (t.running && t.runningRole === "reviewer") return { word: "reviewing", text: "Being reviewed" };
  if (t.running && t.runningRole === "qa") return { word: "testing", text: "Being tested" };
  if (t.running) return { word: "writing", text: "Being written" };
  if (s === "factory:in-review") return { word: "reviewing", text: "Waiting for review" };
  if (s === "factory:in-test") return { word: "testing", text: "Waiting for test" };
  if (s === "factory:in-progress") return { word: "writing", text: "Being written" };
  const after = t.blockedBy.filter((d) => d.open);
  if (s === "factory:ready" && t.approvable) return { word: "waiting-start", text: "Waiting for a start" };
  if (after.length > 0) return { word: "waiting-on", text: `Waiting on #${after.map((d) => d.number).join(", #")}` };
  return { word: "queued", text: "Waiting" };
}

export function BuildBoard({ data }: { data: EpicWorkspace }) {
  const tasks = data.tasks.filter((t) => t.kind !== "test").sort((a, b) => a.number - b.number);
  const words = tasks.map((t) => ({ t, ...taskWord(t) }));
  const built = words.filter((w) => w.word === "done").length;
  const inFlight = words.filter((w) => ["writing", "reviewing", "testing"].includes(w.word)).length;
  const stopped = words.filter((w) => w.word === "stopped");
  const starts = words.filter((w) => w.word === "waiting-start");
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
            {[inFlight > 0 && `${inFlight} in flight`, stopped.length > 0 && `${stopped.length} stopped`, starts.length > 0 && `${starts.length} to start`, waiting > 0 && `${waiting} waiting`]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        {tasks.length === 0 && <p className="muted">No tasks yet. The Planner opens them when the plan is approved.</p>}
        <ol className="task-list">
          {words.map(({ t, word, text }) => (
            <li key={t.id} className={`task-row ${word}`}>
              <span className="task-n">{t.number}</span>
              <span className="task-title">{t.title.replace(/^task\(\d+\):\s*/i, "")}</span>
              <span className={`stage-chip ${word === "done" ? "done" : word === "stopped" ? "halt" : word === "waiting-start" ? "decide" : ["writing", "reviewing", "testing"].includes(word) ? "wait" : ""}`}>
                {text}
              </span>
              {word === "waiting-start" && (
                <span className="task-start">
                  <TaskStartGate epicId={data.epic.id} taskId={t.id} number={t.number} startGate={data.startGate} status={t.startStatus} />
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
        ) : starts.length > 0 ? (
          <p className="need">
            You need to: start {starts.length === 1 ? "the task" : `${starts.length} tasks`} that {starts.length === 1 ? "waits" : "wait"} for a start, above.
          </p>
        ) : (
          <p className="need">Nothing waits on you. The factory has it.</p>
        )}
        <p className="muted">When the build finishes, the tests are run. You are asked again at the release.</p>
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
  const question = peek.data?.blocked?.question ?? null;
  return (
    <section className="card needs-answer" aria-labelledby={`answer-${task.id}`}>
      <div className="spread">
        <h2 id={`answer-${task.id}`}>Needs an answer</h2>
        <span className="muted">Task {task.number}</span>
      </div>
      <p className="need">You need to: answer the builder's question. It continues once you do.</p>
      {question ? <blockquote className="question">{question}</blockquote> : <p className="muted">{peek.isLoading ? "Reading the question…" : "The builder stopped; its question is in the conversation."}</p>}
      {reply.isSuccess ? (
        <p className="muted">Sent. The builder continues from your answer.</p>
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
