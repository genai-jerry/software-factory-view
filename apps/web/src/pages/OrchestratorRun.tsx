import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import { OrchestratorRunDetail, useLiveOrchestratorRun } from "../components/OrchestratorRunView.js";
import { STEP_LABEL, afterRole, roleName, storyOf } from "../lib/runs.js";
import type { PastRunItem, RunningItem } from "../types.js";

/**
 * A run, abstracted (redesign boards 9 and 10): what the factory is doing in
 * four steps, what it has done so far, and what happens when it finishes.
 * The engineers' log, with the model, the events and the transcript, stays
 * one fold below. Factory comments on GitHub link here.
 */
export function OrchestratorRunPage() {
  const { runId = "" } = useParams();
  const run = useLiveOrchestratorRun({ runId, repo: "", enabled: true });
  const running = useQuery({ queryKey: ["running"], queryFn: () => api.get<{ items: RunningItem[] }>("/api/running") });
  const recent = useQuery({ queryKey: ["runs-recent"], queryFn: () => api.get<{ runs: PastRunItem[] }>("/api/runs/recent") });
  const live = running.data?.items.find((i) => i.runId === runId);
  const past = recent.data?.runs.find((r) => r.runId === runId);
  const title = live?.title ?? past?.title ?? null;
  const epicId = live?.epicId ?? past?.epicId ?? null;
  const epicTitle = live?.epicTitle ?? null;
  const story = run.data ? storyOf(run.data) : null;

  return (
    <div className="run-page work-item">
      <p className="crumb">
        <Link to="/">Work</Link>
        {epicId && (
          <>
            {" › "}
            <Link to={`/work/${epicId}`}>{epicTitle ?? "the item"}</Link>
          </>
        )}
      </p>
      {run.isLoading && <p className="muted">Reading the run…</p>}
      {run.isError && <div className="banner error">{(run.error as Error).message}</div>}
      {story && (
        <>
          <header className="wi-head">
            <p className="wi-meta">
              <span className={`stage-chip ${story.running ? "decide" : story.outcome === "success" ? "done" : "halt"}`}>{roleName(story.role)}</span>
              <span className="muted">
                {story.running
                  ? `running for ${story.minutes ?? 0} min`
                  : `finished ${story.finishedAt ? story.finishedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""} · took ${story.minutes ?? 0} min`}
              </span>
            </p>
            <h1>
              {title ? title.replace(/^(?:task|test|bug)\(\d+\):\s*/i, "") : `${run.data?.repo ?? ""} #${run.data?.issue ?? ""}`}
            </h1>
            {epicTitle && <p className="muted">Part of {epicTitle}.</p>}
          </header>

          <nav aria-label="Steps" className="wi-rail">
            {story.steps.map((s) => (
              <span key={s.step} className={`wi-stage ${s.state === "done" ? "done" : s.state === "now" ? "now" : ""}`}>
                <span className="dot" />
                {STEP_LABEL[s.step]}
              </span>
            ))}
          </nav>

          <div className="wi-body">
            <div className="wi-main">
              <section className={`card ${story.running ? "run-now" : ""}`}>
                <h2>{story.running ? "Now" : "How it ended"}</h2>
                <p className="need">{story.now}</p>
                {story.fixAttempts > 0 && story.running && (
                  <p className="muted">
                    Fix attempt {story.fixAttempts}. It stops and asks a person if the tests still fail after three.
                  </p>
                )}
              </section>

              <section className="card">
                <h2>So far</h2>
                {story.soFar.length === 0 ? (
                  <p className="muted">Nothing recorded yet.</p>
                ) : (
                  <ol className="run-sofar">
                    {story.soFar.map((p, i) => (
                      <li key={i} className={p.now ? "now" : "done"}>
                        <span>{p.words}</span>
                        <span className="muted">{p.now ? "now" : p.minutes !== null ? `${p.minutes} min` : ""}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="card">
                <h2>{story.running ? "When it finishes" : "What happens next"}</h2>
                <p>{afterRole(story.role)}</p>
              </section>

              <details className="card run-log-fold">
                <summary>Full log, for engineers</summary>
                <p className="muted">
                  Run <code>{runId}</code>
                  {run.data?.model && <> · model {run.data.model}</>}
                </p>
                <OrchestratorRunDetail runId={runId} repo="" />
              </details>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
