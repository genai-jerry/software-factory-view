import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { bullets, designParts, findSection, paragraphs, scenarios, sections } from "../lib/docs.js";
import { plain } from "../lib/testplan.js";
import type { ArtifactView, EpicWorkspace, GatePanelData } from "../types.js";
import { taskWord } from "./BuildBoard.js";

/**
 * Clarify (redesign board 4) and Design (board 5): the two documents a
 * person approves, shown as the items they agree to rather than as files.
 *
 * Clarify reads the proposal: its summary, the interpretations the Intake
 * Analyst took (the items to agree on) and the spec scenarios (how the
 * factory will check it). Design reads design.md: every section that is not
 * a task is a decision, D1…Dn, and the task sections are the build order.
 * A comment on an item posts to the item's conversation on GitHub, naming
 * the item; Approve and Ask for changes are the gate's own routes.
 */

function useArtifact(epicId: string, path: string | null) {
  return useQuery({
    queryKey: ["artifact", epicId, path],
    queryFn: () => api.get<ArtifactView>(`/api/epics/${epicId}/artifact?path=${encodeURIComponent(path!)}`),
    enabled: path !== null,
    retry: false,
  });
}

function useGate(data: EpicWorkspace, at: string) {
  return useQuery({
    queryKey: ["gate", data.epic.id],
    queryFn: () => api.get<GatePanelData>(`/api/epics/${data.epic.id}/gate`),
    enabled: data.epic.state === at,
    retry: false,
  });
}

export function ClarifyBoard({ data }: { data: EpicWorkspace }) {
  const proposalPath = data.artifacts.find((a) => a.kind === "proposal")?.path ?? null;
  const proposal = useArtifact(data.epic.id, proposalPath);
  const specPaths = data.artifacts.filter((a) => a.kind === "spec").map((a) => a.path);
  const specs = useQueries({
    queries: specPaths.map((path) => ({
      queryKey: ["artifact", data.epic.id, path],
      queryFn: () => api.get<ArtifactView>(`/api/epics/${data.epic.id}/artifact?path=${encodeURIComponent(path)}`),
      retry: false,
    })),
  });
  const gate = useGate(data, "factory:spec-ready");
  const [showAll, setShowAll] = useState(false);

  const doc = proposal.data ? sections(proposal.data.markdown) : null;
  const summary = doc ? [...paragraphs(findSection(doc, "problem"), 1), ...paragraphs(findSection(doc, "desired outcome", "outcome", "proposal"), 1)] : [];
  const items = doc ? bullets(findSection(doc, "interpretations")) : [];
  const checks = specs.flatMap((q) => (q.data ? scenarios(q.data.markdown) : []));
  const deciding = data.epic.state === "factory:spec-ready";

  return (
    <>
      <section className="card">
        <h2>Summary</h2>
        {summary.length > 0 ? (
          summary.map((p, i) => <p key={i}>{plain(p)}</p>)
        ) : proposalPath && proposal.isLoading ? (
          <p className="muted">Reading the write-up…</p>
        ) : data.epic.bodyHtml ? (
          <div className="rel-body" dangerouslySetInnerHTML={{ __html: data.epic.bodyHtml }} />
        ) : (
          <p className="muted">The factory has not written the plan yet.</p>
        )}
        {proposalPath && (
          <p className="muted">
            Written by the factory from the request.{" "}
            <Link to={`/epics/${data.epic.id}?tab=artifacts`}>Read the full write-up</Link>
          </p>
        )}
      </section>

      <section className="card">
        <h2>
          What to agree on {items.length > 0 && <span className="muted">({items.length})</span>}
        </h2>
        {items.length === 0 ? (
          <p className="muted">{doc ? "The write-up lists no interpretations to agree on." : "Appears once the plan is written."}</p>
        ) : (
          <ol className="agree-list">
            {items.map((it, i) => (
              <AgreeItem key={i} n={i + 1} text={plain(it)} epicId={data.epic.id} />
            ))}
          </ol>
        )}
      </section>

      <section className="card">
        <h2>
          How the factory will check it {checks.length > 0 && <span className="muted">({checks.length})</span>}
        </h2>
        {checks.length === 0 ? (
          <p className="muted">The checks appear with the plan.</p>
        ) : (
          <>
            <ul className="facts">
              {(showAll ? checks : checks.slice(0, 3)).map((c, i) => (
                <li key={i}>{plain(c)}</li>
              ))}
            </ul>
            {checks.length > 3 && (
              <button type="button" className="link" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${checks.length}`}
              </button>
            )}
          </>
        )}
      </section>

      <GateDecision
        data={data}
        gate={gate.data ?? null}
        deciding={deciding}
        title="Approve the plan"
        need="approve the plan, or ask for a change."
        after="Approving starts the design."
        waiting="The plan is being written. You will be asked to approve it."
      />
    </>
  );
}

export function DesignBoard({ data }: { data: EpicWorkspace }) {
  const designPath = data.artifacts.find((a) => a.kind === "design")?.path ?? null;
  const design = useArtifact(data.epic.id, designPath);
  const gate = useGate(data, "factory:design-ready");
  const parts = design.data ? designParts(design.data.markdown) : null;
  const cases = data.tasks.filter((t) => t.kind === "test").length;
  const deciding = data.epic.state === "factory:design-ready";
  const byNumber = new Map(data.tasks.map((t) => [t.number, t]));

  return (
    <>
      <section className="card">
        <h2>
          Design decisions {parts && <span className="muted">({parts.decisions.length})</span>}
        </h2>
        {!parts ? (
          <p className="muted">{designPath && design.isLoading ? "Reading the design…" : "Appears once the design is written."}</p>
        ) : parts.decisions.length === 0 ? (
          <p className="muted">
            The design lists no decisions by name. <Link to={`/epics/${data.epic.id}?tab=artifacts`}>Read the design</Link>
          </p>
        ) : (
          <>
            <p className="muted">Each one is a choice the factory made. Comment on any you want changed.</p>
            <ol className="agree-list">
              {parts.decisions.map((d) => (
                <AgreeItem key={d.id} n={d.id} text={plain(d.title)} why={d.why.map(plain)} epicId={data.epic.id} />
              ))}
            </ol>
          </>
        )}
      </section>

      <section className="card">
        <h2>
          How it will be built {parts && parts.tasks.length > 0 && <span className="muted">({parts.tasks.length} tasks)</span>}
        </h2>
        {parts && parts.tasks.length > 0 ? (
          <>
            <p className="muted">The factory builds these in order. You are not asked again unless it gets stuck.</p>
            <ol className="task-list">
              {parts.tasks.map((t) => {
                const row = t.issue ? byNumber.get(t.issue) : undefined;
                return (
                  <li key={t.n} className="task-row">
                    <span className="task-n">{t.n}</span>
                    <span className="task-title">
                      {plain(t.title)}
                      {t.after.length > 0 && <span className="muted"> · after {t.after.join(", ")}</span>}
                    </span>
                    {row && <span className="stage-chip">{taskWord(row).text}</span>}
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <p className="muted">The tasks appear with the design.</p>
        )}
      </section>

      <GateDecision
        data={data}
        gate={gate.data ?? null}
        deciding={deciding}
        title="Approve the design"
        need="approve the design, or ask for a change."
        after={`Approving releases the build${parts && parts.tasks.length > 0 ? `: ${parts.tasks.length} tasks` : ""}. You are asked again only if a builder gets stuck.`}
        waiting="The design is being written. You will be asked to approve it."
      />

      {(cases > 0 || data.systemTests.planned) && (
        <section className="card">
          <h2>Tests that come with it</h2>
          <p>{cases > 0 ? `${cases} test case${cases === 1 ? "" : "s"} for a tester to run once it is built.` : "A test plan is being written."}</p>
        </section>
      )}
    </>
  );
}

function AgreeItem({ n, text, why, epicId }: { n: number | string; text: string; why?: string[]; epicId: string }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const post = useMutation({
    mutationFn: () => api.post(`/api/issues/${epicId}/reply`, { body: `On ${typeof n === "number" ? `item ${n}` : n} (${text.slice(0, 80)}${text.length > 80 ? "…" : ""}):\n\n${body.trim()}` }),
    onSuccess: () => {
      setOpen(false);
      setBody("");
    },
    onError: (e) => setFailure(e instanceof ApiError ? e.message : "That did not go through. Try again."),
  });
  return (
    <li className="agree-item">
      <span className="agree-n">{n}</span>
      <div className="agree-body">
        <p className="agree-text">{text}</p>
        {why?.map((w, i) => (
          <p key={i} className="muted">
            {w}
          </p>
        ))}
        {post.isSuccess ? (
          <p className="muted">Posted to the conversation.</p>
        ) : open ? (
          <div className="decision-reply">
            <label htmlFor={`agree-${epicId}-${n}`}>Your comment on {typeof n === "number" ? `item ${n}` : n}</label>
            <textarea id={`agree-${epicId}-${n}`} rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="decision-actions">
              <button type="button" className="primary" disabled={!body.trim() || post.isPending} onClick={() => post.mutate()}>
                {post.isPending ? "Posting…" : "Post"}
              </button>
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="link" onClick={() => setOpen(true)}>
            Comment
          </button>
        )}
        {failure && <p className="decision-failure">{failure}</p>}
      </div>
    </li>
  );
}

function GateDecision({
  data,
  gate,
  deciding,
  title,
  need,
  after,
  waiting,
}: {
  data: EpicWorkspace;
  gate: GatePanelData | null;
  deciding: boolean;
  title: string;
  need: string;
  after: string;
  waiting: string;
}) {
  const qc = useQueryClient();
  const [changes, setChanges] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const onError = (e: unknown) => setFailure(e instanceof ApiError ? e.message : "That did not go through. Try again.");
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["epic", data.epic.id] }), qc.invalidateQueries({ queryKey: ["gate", data.epic.id] })]);
  const approve = useMutation({
    mutationFn: () => api.post<{ commentUrl: string }>(`/api/epics/${data.epic.id}/gate/approve`, { acknowledgeOpenQuestions: ack }),
    onSuccess: refresh,
    onError,
  });
  const request = useMutation({
    mutationFn: (body: string) => api.post(`/api/epics/${data.epic.id}/gate/request-changes`, { body }),
    onSuccess: () => {
      setChanges(null);
      return refresh();
    },
    onError,
  });
  if (!deciding) {
    return (
      <section className="card">
        <h2>Your decision</h2>
        <p className="need">Nothing waits on you yet.</p>
        <p className="muted">{waiting}</p>
      </section>
    );
  }
  const canDecide = gate ? gate.amApprover : true;
  return (
    <section className="card" aria-labelledby="decision">
      <h2 id="decision">Your decision</h2>
      <p className="need">You need to: {need}</p>
      <ul className="facts">
        {gate && gate.openQuestions.length > 0 && (
          <li>
            {gate.openQuestions.length} question{gate.openQuestions.length === 1 ? " is" : "s are"} still open.{" "}
            <label>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Approve anyway
            </label>
          </li>
        )}
        <li>{after}</li>
      </ul>
      {approve.isSuccess ? (
        <p className="muted">Approved. The factory has it.</p>
      ) : !canDecide ? (
        <p className="muted">This is decided by {gate!.approvers.map((x) => `@${x}`).join(", ")}.</p>
      ) : changes === null ? (
        <div className="decision-actions">
          <button type="button" className="primary" disabled={approve.isPending} onClick={() => approve.mutate()}>
            {approve.isPending ? "Approving…" : title}
          </button>
          <button
            type="button"
            onClick={() => {
              setFailure(null);
              setChanges("");
            }}
          >
            Ask for changes
          </button>
        </div>
      ) : (
        <div className="decision-reply">
          <label htmlFor={`changes-${data.epic.id}`}>What should change?</label>
          <textarea id={`changes-${data.epic.id}`} rows={3} value={changes} onChange={(e) => setChanges(e.target.value)} />
          <div className="decision-actions">
            <button type="button" className="primary" disabled={!changes.trim() || request.isPending} onClick={() => request.mutate(changes.trim())}>
              {request.isPending ? "Sending…" : "Send"}
            </button>
            <button type="button" onClick={() => setChanges(null)}>
              Cancel
            </button>
          </div>
          <p className="muted">Your note posts to the conversation on GitHub.</p>
        </div>
      )}
      {failure && <p className="decision-failure">{failure}</p>}
    </section>
  );
}
