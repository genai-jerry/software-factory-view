import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { OpenQuestions } from "../components/OpenQuestions.js";
import { plain } from "../lib/testplan.js";
import type { ArtifactView, EpicWorkspace, GatePanelData, PrSummary, TimelineEvent } from "../types.js";
import { localTimesHtml } from "../lib/localTimes.js";

/**
 * Release — where the item is and the one decision left (redesign board 8).
 *
 * Three places a finished build can be: built, on staging, in production.
 * "Release to staging" is the GS approval the factory already takes by
 * comment; "Ship to production" merges the promotion pull requests the
 * Release Manager listed, in order, and stops at the first one GitHub
 * declines so nothing is half-shipped without saying so.
 */
export function ReleaseBoard({ data }: { data: EpicWorkspace }) {
  const state = data.epic.state;
  const atStaging = state === "factory:epic-ready";
  const atProduction = state === "factory:in-staging";
  const live = state === "factory:deployed";
  const gate = useQuery({
    queryKey: ["gate", data.epic.id],
    queryFn: () => api.get<GatePanelData>(`/api/epics/${data.epic.id}/gate`),
    enabled: atStaging || atProduction,
    retry: false,
  });
  const timeline = useQuery({
    queryKey: ["timeline", data.epic.id],
    queryFn: () => api.get<{ events: TimelineEvent[] }>(`/api/epics/${data.epic.id}/timeline`),
  });
  const proposalPath = data.artifacts.find((a) => a.kind === "proposal")?.path ?? null;
  const proposal = useQuery({
    queryKey: ["artifact", data.epic.id, proposalPath],
    queryFn: () => api.get<ArtifactView>(`/api/epics/${data.epic.id}/artifact?path=${encodeURIComponent(proposalPath!)}`),
    enabled: proposalPath !== null,
    retry: false,
  });

  const tests = data.rollup.tests;
  const cases = data.tasks.filter((t) => t.kind === "test");
  const skipped = cases.filter((c) => c.state === "factory:test-skipped").length;
  const passed = cases.filter((c) => c.state !== "factory:test-skipped" && (c.state === "factory:test-passed" || (!c.open && c.state !== "factory:test-failed"))).length;
  // A case still open — runnable, failed, or not yet released — has not been
  // run. Said before Ship to production, because shipping then ships untested.
  const notRun = cases.filter((c) => c.open && c.state !== "factory:test-passed" && c.state !== "factory:test-skipped").length;
  const built = `${data.rollup.total} task${data.rollup.total === 1 ? "" : "s"}${cases.length > 0 ? `, ${passed} of ${cases.length} tests passed${skipped > 0 ? `, ${skipped} skipped` : ""}` : ""}`;

  return (
    <>
      <section className="card" aria-labelledby="where">
        <h2 id="where">Where it is</h2>
        <div className="rel-steps">
          <div className="rel-step done">
            <span className="rel-name">Built</span>
            <span className="stage-chip done">Done</span>
            <span className="muted">{built}</span>
          </div>
          <div className={`rel-step ${atStaging ? "now" : atProduction || live ? "done" : ""}`}>
            <span className="rel-name">Staging</span>
            {atStaging ? (
              <span className="stage-chip decide">Your decision</span>
            ) : atProduction ? (
              <span className="stage-chip wait">Running</span>
            ) : live ? (
              <span className="stage-chip done">Done</span>
            ) : (
              <span className="stage-chip">Not yet</span>
            )}
            <span className="muted">
              {atStaging && "Goes to the staging branch when you release it."}
              {atProduction && "On staging. The checks the Release Manager ran are in its report below."}
              {live && "Was on staging before it shipped."}
            </span>
          </div>
          <div className={`rel-step ${atProduction ? "now" : live ? "done" : ""}`}>
            <span className="rel-name">Production</span>
            {atProduction ? <span className="stage-chip decide">Your decision</span> : live ? <span className="stage-chip done">Live</span> : <span className="stage-chip">Not yet</span>}
            <span className="muted">{live ? "In production for its watch period: a day of real use while someone watches for new errors. Close it after a clean day, or let Ops do it." : "Goes live for every customer when you ship it."}</span>
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="gets">
        <h2 id="gets">What customers will get</h2>
        {proposal.data ? (
          <Summary markdown={proposal.data.markdown} />
        ) : data.epic.bodyHtml ? (
          <div className="rel-body" dangerouslySetInnerHTML={{ __html: localTimesHtml(data.epic.bodyHtml, null) }} />
        ) : (
          <p className="muted">No write-up on this item.</p>
        )}
      </section>

      {atStaging && <ReleaseToStaging data={data} gate={gate.data ?? null} />}
      {atProduction && notRun > 0 && (
        <p className="banner warn">
          {notRun} test case{notRun === 1 ? " has" : "s have"} not been run. Shipping now ships untested.
        </p>
      )}
      {atProduction && <ShipToProduction data={data} gate={gate.data ?? null} gateError={gate.isError ? (gate.error as ApiError).message : null} />}
      {live && (
        <section className="card">
          <h2>Live</h2>
          <p className="need">Nothing waits on you. Ops verifies production and closes the item.</p>
        </section>
      )}

      <section className="card" aria-labelledby="how">
        <h2 id="how">How it got here</h2>
        {timeline.data?.events.filter((e) => e.type === "state").length === 0 && <p className="muted">No moves recorded yet.</p>}
        <ol className="rel-history">
          {historyLines(timeline.data?.events ?? []).map((e, i) => (
            <li key={i}>
              <span className="muted">{new Date(e.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span> {e.text}
              <span className="muted"> · {e.who}</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

/** What a state move means, in the reader's words; null for a move not worth a line. */
const MOVE_WORDS: Record<string, string> = {
  "factory:intake": "Added",
  "factory:spec-ready": "The plan was written",
  "factory:spec-approved": "The plan was approved",
  "factory:planned": "Broken into tasks",
  "factory:design-ready": "The design was written",
  "factory:design-approved": "The design was approved; building started",
  "factory:manual-test": "A test case became ready to run",
  "factory:test-passed": "A test case passed",
  "factory:test-failed": "A test case failed",
  "factory:test-skipped": "A test case was skipped",
  "factory:bug-open": "A bug was reported",
  "factory:bug-retest": "A bug fix is ready to re-test",
  "factory:bug-verified": "A bug fix was confirmed",
  "factory:epic-ready": "Built; waiting for the release to staging",
  "factory:in-staging": "Released to staging",
  "factory:deployed": "Shipped to production",
  "factory:blocked": "Stopped with a question",
};

const BOT = /\[bot\]$|^github-actions/;

/**
 * The epic's moves as sentences, oldest first, at most ten: only moves into a
 * state (leaving one says nothing on its own), consecutive repeats folded
 * into one line with a count, and a bot named as the factory.
 */
export function historyLines(events: TimelineEvent[]): Array<{ at: string; text: string; who: string }> {
  const out: Array<{ at: string; text: string; who: string; n: number }> = [];
  for (const e of events) {
    if (e.type !== "state") continue;
    const state = e.detail.match(/^→\s*(factory:[\w-]+)/)?.[1];
    if (!state) continue;
    const text = MOVE_WORDS[state] ?? "Moved on";
    const who = !e.actor || BOT.test(e.actor) ? "the factory" : e.actor;
    const prev = out[out.length - 1];
    if (prev && prev.text === text && prev.who === who) {
      prev.n += 1;
      continue;
    }
    out.push({ at: e.at, text, who, n: 1 });
    if (out.length >= 10) break;
  }
  return out.reverse().map(({ at, text, who, n }) => ({ at, text: n > 1 ? `${text} (${n} times)` : text, who }));
}

/** The first prose paragraphs of a proposal, before any heading past the title. */
function Summary({ markdown }: { markdown: string }) {
  const paras: string[] = [];
  let buf: string[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("# ")) continue;
    if (line.startsWith("#")) {
      if (paras.length >= 2) break;
      continue;
    }
    if (line === "") {
      if (buf.length) paras.push(buf.join(" "));
      buf = [];
      if (paras.length >= 3) break;
      continue;
    }
    // Bookkeeping lines such as `Epic: owner/repo#35` are links, not a summary.
    if (line.startsWith("|") || line.startsWith("- ") || line.startsWith("* ") || /^\d+\./.test(line) || /^\w[\w ]*:\s*\S*#\d+\s*$/.test(line)) continue;
    buf.push(line);
  }
  if (buf.length && paras.length < 3) paras.push(buf.join(" "));
  if (paras.length === 0) return <p className="muted">The write-up has no summary paragraph.</p>;
  return (
    <>
      {paras.map((p, i) => (
        <p key={i}>{plain(p)}</p>
      ))}
    </>
  );
}

function useFailure() {
  const [failure, setFailure] = useState<string | null>(null);
  return { failure, onError: (e: unknown) => setFailure(e instanceof ApiError ? e.message : "That did not go through. Try again."), clear: () => setFailure(null) };
}

/**
 * The staging decision on its own, for a board that is not the Release
 * board: the Test board shows it when the cases run on staging and the item
 * has reached gate GS, because releasing is what makes the cases runnable.
 */
export function StagingRelease({ data }: { data: EpicWorkspace }) {
  const gate = useQuery({
    queryKey: ["gate", data.epic.id],
    queryFn: () => api.get<GatePanelData>(`/api/epics/${data.epic.id}/gate`),
    retry: false,
  });
  return <ReleaseToStaging data={data} gate={gate.data ?? null} />;
}

function ReleaseToStaging({ data, gate }: { data: EpicWorkspace; gate: GatePanelData | null }) {
  const qc = useQueryClient();
  const { failure, onError } = useFailure();
  const [ack, setAck] = useState(false);
  const approve = useMutation({
    mutationFn: () => api.post<{ commentUrl: string }>(`/api/epics/${data.epic.id}/gate/approve`, { acknowledgeOpenQuestions: ack }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["epic", data.epic.id] }),
    onError,
  });
  const a = gate?.assembly;
  const canDecide = gate ? gate.amApprover : true;
  return (
    <section className="card" aria-labelledby="decision">
      <h2 id="decision">Your decision</h2>
      <p className="need">You need to: release it to staging, or hold it.</p>
      <ul className="facts">
        {a && <li>{a.tasks.length} task{a.tasks.length === 1 ? "" : "s"} assembled{a.allGreen ? ", all green" : ""}.</li>}
        {a && a.cases.length > 0 && (
          <li>
            {a.cases.filter((c) => c.verdict === "passed").length} of {a.cases.length} tests passed
            {a.cases.some((c) => c.verdict === "skipped") ? `, ${a.cases.filter((c) => c.verdict === "skipped").length} skipped` : ""}
            {a.testsOutstanding > 0 ? `, ${a.testsOutstanding} outstanding` : ""}.
          </li>
        )}
        {a && a.bugsOpen > 0 && <li>{a.bugsOpen} bug{a.bugsOpen === 1 ? "" : "s"} still open.</li>}
        <li>Releasing merges the epic onto the staging branch. You are asked again before production.</li>
      </ul>
      {gate && <OpenQuestions questions={gate.openQuestions} ack={ack} onAck={setAck} ackLabel="Release anyway, with this question open" />}
      {approve.isSuccess ? (
        <p className="muted">Released. The factory is moving it to staging.</p>
      ) : canDecide ? (
        <div className="decision-actions">
          <button type="button" className="primary" disabled={approve.isPending || ((gate?.openQuestions.length ?? 0) > 0 && !ack)} onClick={() => approve.mutate()}>
            {approve.isPending ? "Releasing…" : "Release to staging"}
          </button>
          <Link to="/" className="button">
            Hold for now
          </Link>
        </div>
      ) : (
        <p className="muted">This release is decided by {gate!.approvers.map((x) => `@${x}`).join(", ")}.</p>
      )}
      {failure && <p className="decision-failure">{failure}</p>}
    </section>
  );
}

export function ShipToProduction({ data, gate, gateError }: { data: EpicWorkspace; gate: GatePanelData | null; gateError: string | null }) {
  const qc = useQueryClient();
  const [progress, setProgress] = useState<Array<{ pr: PrSummary; result: "merged" | "failed" | "pending"; error?: string }>>([]);
  const prs = (gate?.releasePrs ?? []).filter((p) => p.state === "open" && p.kind === "promotion");
  const canDecide = gate ? gate.amApprover : false;
  const ship = useMutation({
    mutationFn: async () => {
      const log: Array<{ pr: PrSummary; result: "merged" | "failed" | "pending"; error?: string }> = prs.map((pr) => ({ pr, result: "pending" }));
      setProgress([...log]);
      for (let i = 0; i < prs.length; i++) {
        try {
          await api.post(`/api/prs/${prs[i]!.id}/merge`);
          log[i] = { pr: prs[i]!, result: "merged" };
        } catch (e) {
          log[i] = { pr: prs[i]!, result: "failed", error: e instanceof ApiError ? e.message : String(e) };
          setProgress([...log]);
          return { shipped: false };
        }
        setProgress([...log]);
      }
      return { shipped: true };
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ["epic", data.epic.id] }), qc.invalidateQueries({ queryKey: ["gate", data.epic.id] })]),
  });
  const failed = progress.find((p) => p.result === "failed");
  const mergedCount = progress.filter((p) => p.result === "merged").length;
  return (
    <section className="card" aria-labelledby="decision">
      <h2 id="decision">Your decision</h2>
      <p className="need">You need to: ship it to production, or hold it.</p>
      <ul className="facts">
        <li>
          Shipping merges {prs.length} promotion pull request{prs.length === 1 ? "" : "s"} in order
          {prs.length > 0 && <>: {prs.map((p) => p.headRef.replace(/^.*\//, "")).join(", ")}</>}. It puts the change live for every customer.
        </li>
        <li>A hold keeps it on staging; nothing is lost.</li>
      </ul>
      {gateError && <p className="decision-failure">{gateError}</p>}
      {progress.length > 0 && (
        <ol className="rel-progress">
          {progress.map((p) => (
            <li key={p.pr.id} className={p.result}>
              {p.pr.title} — {p.result === "merged" ? "merged" : p.result === "failed" ? `stopped: ${p.error}` : "waiting"}
            </li>
          ))}
        </ol>
      )}
      {ship.data?.shipped ? (
        <p className="muted">Shipped. Ops verifies production next.</p>
      ) : failed ? (
        <p className="decision-failure">
          Stopped after {mergedCount} of {prs.length}. {failed.pr.title} was declined. Nothing after it was merged. Fix that one, then ship again; the merged ones stay merged.
        </p>
      ) : !gate ? (
        <p className="muted">Reading the release…</p>
      ) : prs.length === 0 ? (
        <p className="muted">No promotion pull request is open. The Release Manager opens them; start it from the engineers' view if it has not run.</p>
      ) : canDecide ? (
        <div className="decision-actions">
          <button type="button" className="primary" disabled={ship.isPending} onClick={() => ship.mutate()}>
            {ship.isPending ? "Shipping…" : "Ship to production"}
          </button>
          <Link to="/" className="button">
            Hold for now
          </Link>
        </div>
      ) : (
        <p className="muted">Shipping is decided by {gate.approvers.map((x) => `@${x}`).join(", ")}.</p>
      )}
    </section>
  );
}
