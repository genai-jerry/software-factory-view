import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import type { EpicWorkspace } from "../types.js";
import { GitHubLink } from "../components/GitHubLink.js";
import { NextStepLine } from "../components/NextStep.js";

/**
 * The Tests tab: an epic's system test cases (FACTORY.md §4b) and the one
 * action that brings them into being.
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
  const passed = cases.filter((c) => c.state === "factory:test-passed" || (!c.open && c.state !== "factory:test-failed"));
  const failed = cases.filter((c) => c.state === "factory:test-failed");
  const pending = cases.filter(
    (c) => c.open && c.state !== "factory:manual-test" && c.state !== "factory:test-failed" && c.state !== "factory:test-passed",
  );
  return (
    <div>
      <h4 className="phase-head">
        System tests ({passed.length}/{cases.length} passed)
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
 * Pass / Fail on a runnable case. Posts the literal `Test Passed` or
 * `Test Failed` as the acting member, exactly as the gate buttons post
 * `Approved` — the router does everything that follows.
 *
 * The evidence box is optional and is posted first, as an ordinary comment,
 * so the verdict is the newest comment on the thread: the router matches the
 * body exactly, and a verdict with observations appended would not be one.
 */
export function TestVerdict({ caseId, label }: { caseId: string; label: string }) {
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
              ? `Record ${label} as passed? It closes the case.`
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
