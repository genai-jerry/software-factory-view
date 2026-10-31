import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import type { EpicWorkspace } from "../types.js";
import { GitHubLink } from "../components/GitHubLink.js";
import { NextStepLine } from "../components/NextStep.js";

/**
 * The Tests tab: an epic's system test cases (FACTORY.md §4b), the bugs a
 * tester raised against it (§4c), and the two actions that create each.
 *
 * A tab of their own rather than a group at the foot of the task board. A case
 * is not a task — no agent runs on one, none of the board's columns describes
 * it, and the person who reads it is the tester, not the approver watching the
 * build. Below the board it was also the last thing on the longest tab, which
 * is the wrong place for the only work in the factory a human does by hand.
 *
 * The tab renders for every epic, cases or not: an epic with none is exactly
 * the epic that may need to adopt a plan, and a hidden tab has nowhere to say
 * so.
 */
export function TestsTab({ data }: { data: EpicWorkspace }) {
  const cases = data.tasks.filter((t) => t.kind === "test");
  const tests = data.systemTests;
  return (
    <div className="system-tests">
      {tests.enabled === false && cases.length === 0 && (
        <div className="banner info">
          System tests are off in <code>{data.repo.fullName}</code>. The factory writes no test plan and opens no cases
          here. Turning them on is a change to <code>.github/factory-testing.json</code> in the repository.
        </div>
      )}
      {/* An unmerged plan is the reason cases exist and none is runnable —
          the Dispatcher releases a case only once its plan is on the epic's
          home branch. Said once, at the top, rather than on every row. */}
      {tests.plan && !tests.plan.merged && (
        <div className="banner info">
          The test plan (<code>{tests.plan.path}</code>) is written but not merged yet. Cases stay pending until it
          lands — review and merge the plan PR to release them.
        </div>
      )}
      <PlanTests epicId={data.epic.id} tests={tests} hasCases={cases.length > 0} />
      {/* A plan with no case rows: the Test Planner opens the sub-issues in
          the same run that writes the documents, so this is the minutes
          between the run and the projection catching up — or a plan whose
          cases were all closed. Saying so beats an empty tab. */}
      {cases.length === 0 && tests.planned && (
        <p className="muted">
          This epic has a test plan; no case sub-issues are on it. They appear here as the Test Planner opens them.
        </p>
      )}
      <SystemTestCases cases={cases} />
      {/* Bugs sit under the cases, on the same tab, because they come from
          the same hour of somebody's work: a tester runs the cases and finds
          things the cases did not predict. Splitting them onto a tab of their
          own would mean the person doing the testing has two places to look
          and two places to write. */}
      <Bugs epicId={data.epic.id} bugs={data.bugs} />
    </div>
  );
}

/**
 * The epic's bug reports (FACTORY.md §4c) and the control that raises another.
 *
 * A bug is not a case: nobody planned it, it has no steps, and its whole
 * content is what one person saw. So it renders as a report with a state and
 * the task that fixes it — and, when the fix is assembled, the same Pass/Fail
 * control a case gets, because a re-test is a test.
 */
export function Bugs({ epicId, bugs }: { epicId: string; bugs: EpicWorkspace["bugs"] }) {
  const open = bugs.rows.filter((b) => b.open && b.state !== "factory:bug-verified");
  const retest = open.filter((b) => b.state === "factory:bug-retest");
  const fixing = open.filter((b) => b.state !== "factory:bug-retest");
  const closed = bugs.rows.filter((b) => !b.open || b.state === "factory:bug-verified");
  return (
    <div className="bugs">
      <h4 className="phase-head">
        Bugs {bugs.rows.length > 0 ? `(${closed.length}/${bugs.rows.length} verified)` : ""}
      </h4>
      {bugs.enabled === false && bugs.rows.length === 0 ? (
        <div className="banner info">
          Bug reports are off in this repository. Turning them on is a change to{" "}
          <code>.github/factory-testing.json</code> — add <code>"bug_reports": true</code>.
        </div>
      ) : (
        <ReportBug epicId={epicId} report={bugs.report} hasBugs={bugs.rows.length > 0} />
      )}
      {retest.length > 0 && (
        <div className="banner info">
          {retest.length} fix{retest.length === 1 ? "" : "es"} ready to re-test. Run what you did when you found it —
          a pass closes the report, a failure files another fix.
        </div>
      )}
      {[
        { title: "Ready to re-test", items: retest },
        { title: "Being fixed", items: fixing },
        { title: "Verified", items: closed },
      ].map((g) =>
        g.items.length === 0 ? null : (
          <div key={g.title}>
            <h5 className="phase-head">
              {g.title} ({g.items.length})
            </h5>
            {g.items.map((b) => (
              <div className={`board-card${b.state === "factory:bug-open" ? " blocked" : ""}`} key={b.id}>
                #{b.number} {b.title.replace(/^bug\([^)]*\):?\s*/i, "")}
                <div className="meta">
                  <span
                    className={`badge ${
                      b.state === "factory:bug-retest" ? "test-run" : b.state === "factory:bug-open" ? "blocked" : "state"
                    }`}
                  >
                    {b.state === "factory:bug-retest"
                      ? "Ready to re-test"
                      : b.state === "factory:bug-verified" || !b.open
                        ? "Verified"
                        : "Being fixed"}
                  </span>
                  {b.fixes.filter((f) => f.open).length > 0 && (
                    <span title={b.fixes.filter((f) => f.open).map((f) => `#${f.number} ${f.title}`).join("\n")}>
                      fix {b.fixes.filter((f) => f.open).map((f) => `#${f.number}`).join(", ")}
                    </span>
                  )}
                  <GitHubLink href={b.htmlUrl} />
                </div>
                <NextStepLine step={b.nextStep} />
                {b.state === "factory:bug-retest" && <TestVerdict caseId={b.id} label={`#${b.number}`} bug />}
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Raise a bug against this epic.
 *
 * The title and the report go up as one comment, because `Bug` is the one
 * factory control that reads past its own line — and that is exactly why the
 * report field is required here rather than optional: a bug that arrives
 * without what the tester saw is a round trip through somebody's memory.
 *
 * Whether it may be pressed is the server's answer, computed by the same
 * function that guards the endpoint, so the form is never offered where the
 * factory would refuse it.
 */
export function ReportBug({
  epicId,
  report,
  hasBugs,
}: {
  epicId: string;
  report: EpicWorkspace["bugs"]["report"];
  hasBugs: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const raise = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`/api/epics/${epicId}/bugs`, { title, report: detail }),
    onSuccess: () => {
      setTitle("");
      setDetail("");
      setOpen(false);
      void qc.invalidateQueries();
    },
  });

  if (!report.offered) {
    // With bugs already on the epic the list says everything; a greyed-out
    // button beside it would only ask to be pressed. With none, the refusal
    // is the answer to "why can't I report one?".
    return hasBugs ? null : <p className="muted">No bugs on this epic. {report.reason}</p>;
  }

  if (!open) {
    return (
      <div className="dep-actions">
        <button type="button" onClick={() => setOpen(true)}>
          Report a bug
        </button>
        <span className="muted">
          Found something the cases did not predict? The factory raises it against this epic and builds the repair
          onto the epic branch, like any other task.
        </span>
      </div>
    );
  }

  return (
    <div className="banner info">
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="One line: what is wrong"
          aria-label="Bug title"
        />
        <textarea
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder={"What you saw, what you did, what you expected.\nSteps: …\nSaw: … — expected: …"}
          rows={5}
          aria-label="Bug report"
        />
        <div className="dep-actions">
          <span className="muted">
            Posted as you, as a <code>Bug</code> comment on the epic. The factory opens the report and raises the
            work that repairs it.
          </span>
          <button type="button" onClick={() => raise.mutate()} disabled={raise.isPending || !title.trim() || !detail.trim()}>
            {raise.isPending ? "Raising…" : "Raise it"}
          </button>
          <button type="button" className="secondary" onClick={() => setOpen(false)} disabled={raise.isPending}>
            Cancel
          </button>
        </div>
      </div>
      {raise.isError && <div className="banner error">{(raise.error as ApiError).message}</div>}
    </div>
  );
}

/**
 * Ask the Test Planner for a plan (FACTORY.md §4b, "Adopting it on an epic
 * already in flight").
 *
 * The button posts the literal `Plan tests` as the acting user — the same
 * mechanism as Approve and the verdicts — and the factory does everything
 * else. Whether it may be pressed is the server's answer, computed from the
 * repo's policy and the epic's state by the same function that guards the
 * endpoint, so the button never offers a click the factory would refuse.
 *
 * The confirm is not ceremony: this starts an agent that writes two documents
 * and opens a sub-issue per case, and the plan then needs reviewing and
 * merging before any case reaches a tester. Someone pressing it should know
 * that before, not from the notification afterwards.
 */
export function PlanTests({
  epicId,
  tests,
  hasCases,
}: {
  epicId: string;
  tests: EpicWorkspace["systemTests"];
  hasCases: boolean;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const ask = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`/api/epics/${epicId}/plan-tests`, {}),
    onSuccess: () => {
      setConfirming(false);
      void qc.invalidateQueries();
    },
  });

  if (!tests.planTests.offered) {
    // Where the epic already has its plan, the case list below says everything
    // and a greyed-out button beside it would only ask to be pressed. A
    // policy-off repo has its own banner above, which says more than the
    // refusal does. Every other refusal is worth a sentence: it is the answer
    // to "why is there nothing here?".
    if (hasCases || tests.planned || tests.enabled === false) return null;
    return <p className="muted">No system tests on this epic. {tests.planTests.reason}</p>;
  }

  return (
    <div className="banner info">
      <div>
        <strong>No test plan on this epic yet.</strong> The Test Planner can write one from the approved spec and the
        task breakdown: <code>system-tests/test-plan.md</code>, <code>test-data.md</code>, and one case sub-issue per
        test. The plan arrives as a PR — cases become runnable once it is merged and the code they cover is assembled.
      </div>
      {confirming ? (
        <div className="dep-actions">
          <span className="muted">
            Ask the Test Planner for a plan? It comments <code>Plan tests</code> on this epic as you, and leaves the
            epic in the state it is in.
          </span>
          <button type="button" onClick={() => ask.mutate()} disabled={ask.isPending}>
            {ask.isPending ? "Asking…" : "Confirm"}
          </button>
          <button type="button" className="secondary" onClick={() => setConfirming(false)} disabled={ask.isPending}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="dep-actions">
          <button type="button" onClick={() => setConfirming(true)}>
            Plan tests
          </button>
        </div>
      )}
      {ask.isError && <div className="banner error">{(ask.error as ApiError).message}</div>}
    </div>
  );
}

/**
 * The case list — the work a person does against the assembled change.
 *
 * Pending cases are shown too, because "three cases exist and none is runnable
 * yet" is the honest reading of an epic mid-build; hiding them would make the
 * tests look absent rather than waiting.
 */
export function SystemTestCases({ cases }: { cases: EpicWorkspace["tasks"] }) {
  if (cases.length === 0) return null;
  const runnable = cases.filter((c) => c.state === "factory:manual-test");
  const skipped = cases.filter((c) => c.state === "factory:test-skipped");
  const passed = cases.filter((c) => c.state !== "factory:test-skipped" && (c.state === "factory:test-passed" || (!c.open && c.state !== "factory:test-failed")));
  const failed = cases.filter((c) => c.state === "factory:test-failed");
  const pending = cases.filter(
    (c) => c.open && c.state !== "factory:manual-test" && c.state !== "factory:test-failed" && c.state !== "factory:test-passed",
  );
  return (
    <div>
      <h4 className="phase-head">
        System tests ({passed.length}/{cases.length} passed{skipped.length > 0 ? `, ${skipped.length} skipped` : ""})
      </h4>
      {runnable.length > 0 && (
        <div className="banner info">
          {runnable.length} case{runnable.length === 1 ? "" : "s"} ready to run. Run it against the environment the
          plan names, then record what you saw — a pass closes the case, a failure files the task to fix it.
        </div>
      )}
      {runnable.length === 0 && pending.length > 0 && (
        <div className="banner info">
          {pending.length} case{pending.length === 1 ? "" : "s"} not runnable yet — each waits for the tasks it
          covers to be assembled, and for the test plan to be merged.
        </div>
      )}
      {[
        { title: "Ready to run", items: runnable },
        { title: "Failed", items: failed },
        { title: "Not runnable yet", items: pending },
        { title: "Passed", items: passed },
      ].map((g) =>
        g.items.length === 0 ? null : (
          <div key={g.title}>
            <h5 className="phase-head">
              {g.title} ({g.items.length})
            </h5>
            {g.items.map((c) => (
              <div className={`board-card${c.state === "factory:test-failed" ? " blocked" : ""}`} key={c.id}>
                {c.caseId ? <strong>{c.caseId}</strong> : null} #{c.number}{" "}
                {c.title.replace(/^test\([^)]*\):?\s*(ST-\d+)?\s*/i, "")}
                <div className="meta">
                  <span
                    className={`badge ${
                      c.state === "factory:test-failed" ? "blocked" : c.state === "factory:manual-test" ? "test-run" : "state"
                    }`}
                  >
                    {c.state === "factory:manual-test"
                      ? "Ready to run"
                      : c.state === "factory:test-skipped"
                        ? "Skipped"
                        : c.state === "factory:test-passed" || !c.open
                          ? "Passed"
                          : c.state === "factory:test-failed"
                            ? "Failed"
                            : "Waiting"}
                  </span>
                  {c.blockedBy.filter((d) => d.open).length > 0 && (
                    <span title={c.blockedBy.filter((d) => d.open).map((d) => `#${d.number} ${d.title}`).join("\n")}>
                      after {c.blockedBy.filter((d) => d.open).map((d) => `#${d.number}`).join(", ")}
                    </span>
                  )}
                  <GitHubLink href={c.htmlUrl} />
                </div>
                <NextStepLine step={c.nextStep} />
                {c.state === "factory:manual-test" && <TestVerdict caseId={c.id} label={c.caseId ?? `#${c.number}`} />}
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Pass / Fail on a runnable case — or on a bug whose fix is assembled (§4c),
 * which takes the same two words from the same list, because a re-test is a
 * test. Posts the literal `Test Passed` or `Test Failed` as the acting member,
 * exactly as the gate buttons post `Approved` — the router does everything
 * that follows.
 *
 * The evidence box is optional and is posted first, as an ordinary comment,
 * so the verdict is the newest comment on the thread: the router matches the
 * body exactly, and a verdict with observations appended would not be one.
 */
export function TestVerdict({ caseId, label, bug }: { caseId: string; label: string; bug?: boolean }) {
  const qc = useQueryClient();
  const [evidence, setEvidence] = useState("");
  const [confirming, setConfirming] = useState<null | "passed" | "failed">(null);
  const post = useMutation({
    mutationFn: (verdict: "passed" | "failed") =>
      api.post(`/api/issues/${caseId}/test-verdict`, { verdict, evidence: evidence.trim() || undefined }),
    onSuccess: () => {
      setEvidence("");
      setConfirming(null);
      void qc.invalidateQueries();
    },
  });
  return (
    <div className="dep-actions" style={{ flexDirection: "column", alignItems: "stretch", gap: "0.4rem" }}>
      <textarea
        value={evidence}
        onChange={(e) => setEvidence(e.target.value)}
        placeholder="What you saw (optional) — posted as a comment before the verdict"
        rows={2}
        aria-label={`Evidence for ${label}`}
      />
      {confirming === null ? (
        <div className="dep-actions">
          <button type="button" onClick={() => setConfirming("passed")} disabled={post.isPending}>
            Pass
          </button>
          <button type="button" className="secondary" onClick={() => setConfirming("failed")} disabled={post.isPending}>
            Fail
          </button>
        </div>
      ) : (
        <div className="dep-actions">
          <span className="muted">
            {confirming === "passed"
              ? bug
                ? `Confirm ${label} is repaired? It closes the report.`
                : `Record ${label} as passed? It closes the case.`
              : bug
                ? `Report ${label} as still open? The factory files another fix and brings it back when that lands.`
                : `Record ${label} as failed? The factory files a task to fix it and brings this case back when that lands.`}
          </span>
          <button type="button" onClick={() => post.mutate(confirming)} disabled={post.isPending}>
            {post.isPending ? "Posting…" : "Confirm"}
          </button>
          <button type="button" className="secondary" onClick={() => setConfirming(null)} disabled={post.isPending}>
            Cancel
          </button>
        </div>
      )}
      {post.isError && <div className="banner error">{(post.error as ApiError).message}</div>}
    </div>
  );
}
