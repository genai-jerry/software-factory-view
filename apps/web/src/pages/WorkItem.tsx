import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api.js";
import { RepoChip } from "../components/RepoChip.js";
import { EXPEDITE_BADGE, EXPEDITE_TITLE, peopleLabel } from "../lib/labels.js";
import { STAGES, STAGE_LABEL, stageOf, type Stage } from "../lib/work.js";
import { caseIdOf, parseTestPlan, plain, type PlanCase, type TestPlan } from "../lib/testplan.js";
import type { ArtifactView, EpicWorkspace, Me } from "../types.js";
import { GateTab, TasksTab, ThreadsTab } from "./EpicWorkspace.js";
import { QaPanel } from "./QaPanel.js";
import { ReportBug, TestVerdict } from "./SystemTests.js";

/**
 * One work item, stage by stage (redesign boards 4–8). The page is the
 * stage's decision: the header and the rail are the same everywhere, and the
 * body is what a person has to do at this stage. Test is built in the
 * redesign's shape; the other stages show the existing panels under the new
 * header until their boards land. The engineers' workspace stays at
 * `/epics/:id`.
 */
export function WorkItemPage({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const ws = useQuery({
    queryKey: ["epic", id],
    queryFn: () => api.get<EpicWorkspace>(`/api/epics/${id}`),
    refetchInterval: 30_000,
  });
  if (ws.isError) return <div className="banner error">{(ws.error as ApiError).message}</div>;
  if (!ws.data) return <p className="muted">Loading…</p>;
  const data = ws.data;
  const cases = data.tasks.filter((t) => t.kind === "test");
  const stage = stageFor(data, cases);

  return (
    <div className="work-item">
      <p className="crumb">
        <Link to="/">Work</Link> › {data.epic.title}
      </p>
      <header className="wi-head">
        <h1>{data.epic.title}</h1>
        <p className="muted wi-meta">
          <RepoChip fullName={data.repo.fullName} />
          {data.epic.author && <> · added by {data.epic.author}</>}
          {data.rollup.total > 0 && <> · {data.rollup.total} task{data.rollup.total === 1 ? "" : "s"}</>}
          {data.expedite.on && (
            <>
              {" "}
              <span className="badge expedite" title={EXPEDITE_TITLE}>
                {EXPEDITE_BADGE}
              </span>
            </>
          )}
          {" · "}
          <a href={data.epic.htmlUrl} target="_blank" rel="noreferrer">
            Open on GitHub
          </a>
          {" · "}
          <Link to={`/epics/${data.epic.id}`}>Engineers' view</Link>
        </p>
      </header>
      <StageRail current={stage} state={data.epic.state} />

      <div className="wi-body">
        <div className="wi-main">
          {stage === "test" ? (
            <TestBoard data={data} cases={cases} />
          ) : stage === "clarify" || stage === "design" || stage === "release" ? (
            <GateOrWait data={data} me={me} stage={stage} />
          ) : stage === "build" ? (
            <>
              <section className="card">
                <h2>Tasks</h2>
                <TasksTab data={data} />
              </section>
              <section className="card">
                <h2>Conversations</h2>
                <ThreadsTab data={data} />
              </section>
            </>
          ) : (
            <section className="card">
              <h2>{peopleLabel(data.epic.state)}</h2>
              <p>{data.epic.nextStep.how}</p>
              <ThreadsTab data={data} />
            </section>
          )}
        </div>
        <aside className="wi-side">
          <section className="card">
            <h2>Ask the factory</h2>
            <p className="muted">About this item, from the write-up, the conversation and the code.</p>
            <QaPanel scope={{ kind: "epic", id: data.epic.id }} />
          </section>
        </aside>
      </div>
    </div>
  );
}

/**
 * The stage from the label and the rollup, with one correction the rollup
 * cannot make: an epic whose cases are runnable, failed or awaiting a re-test
 * is at Test even when the Console has not linked the cases to it.
 */
function stageFor(data: EpicWorkspace, cases: EpicWorkspace["tasks"]): Stage | null {
  const base = stageOf(data.epic.state, data.rollup);
  if (base !== "build") return base;
  const codeTasks = data.tasks.filter((t) => t.kind !== "test" && t.open);
  const stillBuilding = codeTasks.some((t) =>
    ["factory:ready", "factory:in-review", "factory:in-test", "factory:blocked"].includes(t.state ?? ""),
  );
  const testing = cases.some((c) => c.open && ["factory:manual-test", "factory:test-failed"].includes(c.state ?? ""));
  const retest = data.bugs.rows.some((b) => b.open && b.state === "factory:bug-retest");
  return !stillBuilding && (testing || retest) ? "test" : base;
}

function StageRail({ current, state }: { current: Stage | null; state: string | null }) {
  const at = current ? STAGES.indexOf(current) : -1;
  return (
    <nav aria-label="Stage" className="wi-rail">
      {STAGES.map((s, i) => (
        <span key={s} className={`wi-stage${i < at ? " done" : i === at ? " now" : ""}`} aria-current={i === at ? "step" : undefined}>
          <span className="dot" />
          {STAGE_LABEL[s]}
        </span>
      ))}
      {at < 0 && <span className="stage-chip halt">{peopleLabel(state)}</span>}
    </nav>
  );
}

function GateOrWait({ data, me, stage }: { data: EpicWorkspace; me: Me; stage: Stage }) {
  const gateOpen =
    data.gate !== null &&
    ["factory:spec-ready", "factory:design-ready", "factory:epic-ready", "factory:in-staging"].includes(data.epic.state ?? "");
  const waiting = { clarify: "The plan is being written.", design: "The design is being written.", release: "Waiting on the release." }[
    stage as "clarify" | "design" | "release"
  ];
  return (
    <>
      <section className="card">
        <h2>{gateOpen ? "Your decision" : waiting}</h2>
        {gateOpen ? (
          <GateTab epicId={data.epic.id} me={me} />
        ) : (
          <p>
            {data.epic.nextStep.who}: {data.epic.nextStep.how}
          </p>
        )}
      </section>
      <section className="card">
        <h2>Conversations</h2>
        <ThreadsTab data={data} />
      </section>
    </>
  );
}

type CaseRow = EpicWorkspace["tasks"][number];

function verdictOf(c: CaseRow): "passed" | "failed" | "runnable" | "pending" {
  if (c.state === "factory:test-passed" || (!c.open && c.state !== "factory:test-failed")) return "passed";
  if (c.state === "factory:test-failed") return "failed";
  if (c.state === "factory:manual-test") return "runnable";
  return "pending";
}

/** Test — the cases a person runs (redesign board 7). */
export function TestBoard({ data, cases }: { data: EpicWorkspace; cases: EpicWorkspace["tasks"] }) {
  const planPath = data.systemTests.plan?.path ?? null;
  const planDoc = useQuery({
    queryKey: ["artifact", data.epic.id, planPath],
    queryFn: () => api.get<ArtifactView>(`/api/epics/${data.epic.id}/artifact?path=${encodeURIComponent(planPath!)}`),
    enabled: planPath !== null,
    retry: false,
  });
  const plan: TestPlan | null = planDoc.data ? parseTestPlan(planDoc.data.markdown) : null;
  const [showPassed, setShowPassed] = useState(false);

  const byVerdict = { runnable: [] as CaseRow[], failed: [] as CaseRow[], pending: [] as CaseRow[], passed: [] as CaseRow[] };
  for (const c of cases) byVerdict[verdictOf(c)].push(c);
  const total = cases.length;
  const passed = byVerdict.passed.length;
  const toRun = byVerdict.runnable.length;
  const failed = byVerdict.failed.length;
  const retests = data.bugs.rows.filter((b) => b.open && b.state === "factory:bug-retest");

  return (
    <>
      <section className="card" aria-labelledby="cases">
        <div className="spread">
          <h2 id="cases">
            Test cases <span className="muted">{total > 0 ? `${passed} of ${total} passed` : ""}</span>
          </h2>
          <span className="muted">
            {[failed > 0 && `${failed} failed`, toRun > 0 && `${toRun} to run`, byVerdict.pending.length > 0 && `${byVerdict.pending.length} not ready`]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        {toRun > 0 && (
          <p className="muted">Run each one on the environment below, then press Pass or Fail. A fail files the fix for you.</p>
        )}
        {total === 0 && <p className="muted">No test cases on this item yet. The Test Planner opens them once the plan is written.</p>}
        {[...byVerdict.runnable, ...byVerdict.failed].map((c) => (
          <TestCase key={c.id} c={c} plan={plan} />
        ))}
        {byVerdict.pending.map((c) => (
          <TestCase key={c.id} c={c} plan={plan} />
        ))}
        {passed > 0 && (
          <div className="tc-passed">
            <button type="button" className="link" onClick={() => setShowPassed((v) => !v)}>
              {showPassed ? "Hide" : "Show"} the {passed} passed test{passed === 1 ? "" : "s"}
            </button>
            {showPassed && byVerdict.passed.map((c) => <TestCase key={c.id} c={c} plan={plan} />)}
          </div>
        )}
      </section>

      {retests.length > 0 && (
        <section className="card">
          <h2>Fixes to re-test ({retests.length})</h2>
          <p className="muted">Run what you did when you found it. A pass closes the report; a fail files another fix.</p>
          {retests.map((b) => (
            <div className="tc" key={b.id}>
              <div className="tc-head">
                <strong>#{b.number}</strong> {b.title.replace(/^bug\(\d+\):\s*/i, "")}
              </div>
              <TestVerdict caseId={b.id} label={`#${b.number}`} bug />
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2>Before you start</h2>
        {plan?.environment ? (
          <>
            {plan.environment.notes.slice(0, 2).map((n, i) => (
              <p key={i}>{plain(n)}</p>
            ))}
            {plan.environment.rows.length > 0 && (
              <dl className="tc-env">
                {plan.environment.rows.map(([k, v]) => (
                  <div key={k}>
                    <dt>{plain(k)}</dt>
                    <dd>{plain(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </>
        ) : planPath && !planDoc.isError ? (
          <p className="muted">Reading the test plan…</p>
        ) : (
          <p className="muted">The plan does not say where to run these. Ask the factory below, or read the plan on GitHub.</p>
        )}
      </section>

      <section className="card">
        <h2>{toRun > 0 ? "Waiting on tests" : failed > 0 ? "Waiting on a fix" : "All tests passed"}</h2>
        <p className="need">
          {toRun > 0
            ? `A tester needs to: run ${toRun === 1 ? "the remaining case" : `the ${toRun} remaining cases`}.`
            : failed > 0
              ? "The fix is being built. The failed case comes back here for a re-test once it lands."
              : "The release is the next decision."}
        </p>
        <p className="muted">
          {data.systemTests.mode === "gate"
            ? "When every case passes, the item goes to the release decision. A case that fails comes back here once its fix is built."
            : "These tests advise; they do not hold the release."}
        </p>
      </section>

      <section className="card">
        <h2>Found something else?</h2>
        <p className="muted">A problem outside these tests. The factory files the fix and brings it back for a re-test.</p>
        <ReportBug epicId={data.epic.id} report={data.bugs.report} hasBugs={data.bugs.rows.length > 0} />
      </section>
    </>
  );
}

function TestCase({ c, plan }: { c: CaseRow; plan: TestPlan | null }) {
  const verdict = verdictOf(c);
  const id = caseIdOf(c.title, c.caseId);
  const planned: PlanCase | undefined = id && plan ? plan.cases.get(id) : undefined;
  const title = c.title.replace(/^test\([^)]*\):?\s*(?:ST|TC)-\d+\s*/i, "");
  const [open, setOpen] = useState(verdict === "runnable");
  const after = c.blockedBy.filter((d) => d.open);
  return (
    <article className={`tc ${verdict}`} aria-label={`${id ?? `#${c.number}`}: ${title}`}>
      <div className="tc-head">
        <span className="tc-id">{id ?? `#${c.number}`}</span>
        <span className="tc-title">{title}</span>
        <span className={`stage-chip ${verdict === "runnable" ? "decide" : verdict === "failed" ? "halt" : verdict === "passed" ? "done" : ""}`}>
          {verdict === "runnable" ? "Run it" : verdict === "failed" ? "Failed · fix being built" : verdict === "passed" ? "Passed" : "Not ready"}
        </span>
      </div>
      {verdict === "pending" && after.length > 0 && (
        <p className="muted">
          After {after.map((d) => `#${d.number}`).join(", ")} {after.length === 1 ? "is" : "are"} built.
        </p>
      )}
      {planned && (planned.steps.length > 0 || planned.expected) && (
        <div className="tc-steps">
          <button type="button" className="link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Hide steps" : "Steps"}
          </button>
          {open && (
            <>
              {planned.preconditions && (
                <p>
                  <strong>Before:</strong> {plain(planned.preconditions)}
                </p>
              )}
              {planned.steps.length > 0 && (
                <ol>
                  {planned.steps.map((s, i) => (
                    <li key={i}>{plain(s)}</li>
                  ))}
                </ol>
              )}
              {planned.expected && (
                <p>
                  <strong>Expect:</strong> {plain(planned.expected)}
                </p>
              )}
            </>
          )}
        </div>
      )}
      {!planned && verdict === "runnable" && (
        <p className="muted">
          The steps are in the plan on GitHub.{" "}
          <a href={c.htmlUrl} target="_blank" rel="noreferrer">
            Open the case
          </a>
          .
        </p>
      )}
      {verdict === "runnable" && <TestVerdict caseId={c.id} label={id ?? `#${c.number}`} />}
    </article>
  );
}
