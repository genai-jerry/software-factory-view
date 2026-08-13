import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api.js";
import type {
  ArtifactView,
  Decision,
  EpicWorkspace,
  GatePanelData,
  Me,
  ThreadDetail,
  TimelineEvent,
} from "../types.js";
import { DecisionCard } from "./Decisions.js";
import { QaPanel } from "./QaPanel.js";

const RAIL_LABELS: Record<string, string> = {
  "factory:intake": "intake",
  "factory:spec-ready": "G1",
  "factory:spec-approved": "spec ✓",
  "factory:planned": "planned",
  "factory:design-ready": "G2",
  "factory:design-approved": "design ✓",
  "factory:ready": "ready",
  "factory:in-review": "review",
  "factory:in-test": "test",
  "factory:ready-to-ship": "G3",
  "factory:deployed": "done",
};

type Tab = "overview" | "artifacts" | "gate" | "tasks" | "threads" | "decisions";

export function EpicWorkspacePage({ me }: { me: Me }) {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) ?? "overview";
  const setTab = (t: Tab) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });

  const ws = useQuery({
    queryKey: ["epic", id],
    queryFn: () => api.get<EpicWorkspace>(`/api/epics/${id}`),
    refetchInterval: 30_000,
  });

  if (ws.isError) return <div className="banner error">{(ws.error as ApiError).message}</div>;
  if (!ws.data) return <p className="muted">Loading workspace…</p>;
  const data = ws.data;

  const gateOpen = data.gate !== null && (data.epic.state === "factory:spec-ready" || data.epic.state === "factory:design-ready" || data.epic.state === "factory:ready-to-ship");

  return (
    <div>
      <div className="spread">
        <h1 style={{ marginBottom: 0 }}>
          Epic #{data.epic.number} · {data.epic.title}
          <a className="raw-link" href={data.epic.htmlUrl} target="_blank" rel="noreferrer">
            ≡ raw
          </a>
        </h1>
        <span className="badge state">{data.epic.state ?? "no factory state"}</span>
      </div>

      <StageRail pipeline={data.pipeline} current={data.epic.state} pendingMine={gateOpen && data.gate!.amApprover} />

      {data.freshness.stale && (
        <div className="banner stale">
          Last sync {data.freshness.lastSyncedAt ? new Date(data.freshness.lastSyncedAt).toLocaleString() : "never"} — this view
          may be stale.
        </div>
      )}
      {data.blockedSubIssues.length > 0 && (
        <div className="banner error">
          {data.blockedSubIssues.map((b) => (
            <div key={b.id}>
              ⛔ Task #{b.number} is blocked: {b.title} —{" "}
              <Link to={`/epics/${data.epic.id}?tab=threads`}>answer it from a thread</Link> or{" "}
              <a href={b.htmlUrl} target="_blank" rel="noreferrer">
                on GitHub
              </a>
            </div>
          ))}
        </div>
      )}
      {gateOpen && data.gate!.amApprover && (
        <div className="banner info">
          {data.gate!.label} is waiting on you.{" "}
          <a
            onClick={(e) => {
              e.preventDefault();
              setTab("gate");
            }}
            href="?tab=gate"
          >
            Open the gate panel →
          </a>
        </div>
      )}

      <div className="tabs">
        {(["overview", "artifacts", ...(gateOpen ? (["gate"] as const) : []), "tasks", "threads", "decisions"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t === "gate" ? `gate (${data.gate?.label})` : t}
            {t === "threads" && ` (${data.threads.filter((th) => Number(th.entryCount) > 0).length})`}
          </button>
        ))}
      </div>

      <div className="workspace" style={{ gridTemplateColumns: "minmax(0,1fr) 340px" }}>
        <div>
          {tab === "overview" && <OverviewTab data={data} />}
          {tab === "artifacts" && <ArtifactsTab data={data} />}
          {tab === "gate" && gateOpen && <GateTab epicId={data.epic.id} me={me} />}
          {tab === "tasks" && <TasksTab data={data} />}
          {tab === "threads" && <ThreadsTab data={data} />}
          {tab === "decisions" && <DecisionsTab epicId={data.epic.id} />}
        </div>
        <div className="context-rail">
          <QaPanel scope={{ kind: "epic", id: data.epic.id }} />
          <TimelineRail epicId={data.epic.id} />
        </div>
      </div>
    </div>
  );
}

function StageRail({ pipeline, current, pendingMine }: { pipeline: string[]; current: string | null; pendingMine: boolean }) {
  const idx = current ? pipeline.indexOf(current) : -1;
  return (
    <div className="stage-rail">
      {pipeline.map((s, i) => {
        const cls = i < idx ? "past" : i === idx ? (pendingMine ? "attention" : "current") : "";
        return (
          <span className={`stage ${cls}`} key={s} title={s}>
            {i > 0 && <span className="bar" />}
            <span className="dot" />
            <span className="lbl">{RAIL_LABELS[s] ?? s}</span>
          </span>
        );
      })}
      {current && idx === -1 && <span className="badge blocked">{current}</span>}
    </div>
  );
}

function OverviewTab({ data }: { data: EpicWorkspace }) {
  return (
    <div>
      <div className="card">
        <h3>Requirement</h3>
        <div className="markdown-body" dangerouslySetInnerHTML={{ __html: data.epic.bodyHtml || "<p class='muted'>(no body)</p>" }} />
        <p className="muted">
          Filed by @{data.epic.author} in {data.repo.fullName}
        </p>
      </div>
      {data.rollup.total > 0 && (
        <div className="card">
          <h3>Task rollup</h3>
          <div className="row">
            <span className="badge">{data.rollup.done} done</span>
            <span className="badge task-start">{data.rollup.ready} ready</span>
            <span className="badge">{data.rollup.inReview} in review</span>
            <span className="badge">{data.rollup.inTest} in test</span>
            {data.rollup.blocked > 0 && <span className="badge blocked">{data.rollup.blocked} blocked</span>}
          </div>
        </div>
      )}
      {data.change && (
        <div className="card">
          <h3>Change folder</h3>
          <p>
            <code>openspec/changes/{data.change.slug}/</code> — {data.artifacts.length} artifacts
            {data.artifacts.some((a) => a.diverged) && (
              <span className="badge gate" style={{ marginLeft: 8 }}>
                proposed ≠ approved
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

function ArtifactsTab({ data }: { data: EpicWorkspace }) {
  const [selected, setSelected] = useState(data.artifacts[0]?.path ?? "");
  const [ref, setRef] = useState<"proposed" | "approved">("proposed");
  const artifact = useQuery({
    queryKey: ["artifact", data.epic.id, selected, ref],
    queryFn: () => api.get<ArtifactView>(`/api/epics/${data.epic.id}/artifact?path=${encodeURIComponent(selected)}&ref=${ref}`),
    enabled: Boolean(selected),
    retry: false,
  });

  if (data.artifacts.length === 0)
    return <p className="muted">No change-folder artifacts discovered yet (fast-track epics have none; otherwise the reconciler may still be catching up).</p>;

  return (
    <div>
      <div className="row" style={{ marginBottom: "0.75rem" }}>
        <select value={selected} onChange={(e) => setSelected(e.target.value)} style={{ width: "auto", flex: 1 }}>
          {data.artifacts.map((a) => (
            <option key={a.path} value={a.path}>
              [{a.kind}] {a.path}
              {a.diverged ? "  (proposed ≠ approved)" : ""}
            </option>
          ))}
        </select>
        <div className="tabs" style={{ border: "none", margin: 0 }}>
          <button className={ref === "proposed" ? "active" : ""} onClick={() => setRef("proposed")}>
            as proposed
          </button>
          <button className={ref === "approved" ? "active" : ""} onClick={() => setRef("approved")}>
            as approved
          </button>
        </div>
      </div>
      <div className="card">
        {artifact.isError && <p className="muted">{(artifact.error as ApiError).message}</p>}
        {artifact.data && (
          <>
            <p className="muted">
              rendering <code>{artifact.data.sha.slice(0, 7)}</code> ({artifact.data.ref})
            </p>
            <div className="markdown-body" dangerouslySetInnerHTML={{ __html: artifact.data.html }} />
          </>
        )}
      </div>
    </div>
  );
}

function GateTab({ epicId, me }: { epicId: string; me: Me }) {
  const qc = useQueryClient();
  const gate = useQuery({
    queryKey: ["gate", epicId],
    queryFn: () => api.get<GatePanelData>(`/api/epics/${epicId}/gate`),
    retry: false,
  });
  const [requestBody, setRequestBody] = useState("");
  const [showRequest, setShowRequest] = useState(false);
  const [ack, setAck] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);

  // Record "I looked at this at this sha" for the next what-changed diff.
  useEffect(() => {
    if (gate.data?.currentSha) {
      void api.post(`/api/epics/${epicId}/gate-view`, { gate: gate.data.gate, sha: gate.data.currentSha }).catch(() => undefined);
    }
  }, [epicId, gate.data?.gate, gate.data?.currentSha]);

  const approve = useMutation({
    mutationFn: () => api.post<{ commentUrl: string }>(`/api/epics/${epicId}/gate/approve`, { acknowledgeOpenQuestions: ack }),
    onSuccess: (r) => {
      setActionOk(`Approved — comment posted as you (${r.commentUrl}). The factory router takes it from here.`);
      setActionError(null);
      void qc.invalidateQueries({ queryKey: ["epic", epicId] });
    },
    onError: (e) => setActionError((e as ApiError).message),
  });

  const requestChanges = useMutation({
    mutationFn: () => api.post(`/api/epics/${epicId}/gate/request-changes`, { body: requestBody }),
    onSuccess: () => {
      setActionOk("Comment posted.");
      setShowRequest(false);
      setRequestBody("");
      setActionError(null);
    },
    onError: (e) => setActionError((e as ApiError).message),
  });

  const merge = useMutation({
    mutationFn: (prId: string) => api.post(`/api/prs/${prId}/merge`),
    onSuccess: () => {
      setActionOk("Merged.");
      void qc.invalidateQueries({ queryKey: ["gate", epicId] });
    },
    onError: (e) => setActionError((e as ApiError).message),
  });

  if (gate.isError) return <div className="banner error">{(gate.error as ApiError).message}</div>;
  if (!gate.data) return <p className="muted">Loading gate panel…</p>;
  const g = gate.data;

  return (
    <div>
      {actionOk && <div className="banner info">{actionOk}</div>}
      {actionError && <div className="banner error">{actionError}</div>}

      <div className="card">
        <div className="spread">
          <h3 style={{ margin: 0 }}>
            {g.label} — {g.gate} gate
          </h3>
          <span className="muted">
            approvers:{" "}
            {g.approvers.length === 0 ? "any collaborator (empty list)" : g.approvers.map((a) => `@${a}`).join(", ")}
          </span>
        </div>
        {g.changedSinceLastView && (
          <div className="banner stale">
            The artifact changed since you last looked (you saw <code>{g.lastViewedSha?.slice(0, 7)}</code>, it is now{" "}
            <code>{g.currentSha?.slice(0, 7)}</code>).
          </div>
        )}
        {!g.amApprover && (
          <p className="muted">You are not on this gate's approver list — the actions below are hidden for you.</p>
        )}
      </div>

      {g.documentPrs.length > 0 && (
        <div className="card">
          <h3>What you are approving</h3>
          {g.documentPrs.map((pr) => (
            <p key={pr.id}>
              <span className={`badge ${pr.state === "open" ? "state" : ""}`}>{pr.state}</span> PR #{pr.number} {pr.title}{" "}
              <span className="muted">
                ({pr.headRef} → {pr.baseRef}, CI: {pr.ciStatus ?? "unknown"})
              </span>
              <a className="raw-link" href={pr.htmlUrl} target="_blank" rel="noreferrer">
                ≡ raw
              </a>
            </p>
          ))}
        </div>
      )}

      {g.artifacts.map((a) => (
        <div className="card" key={a.path}>
          <h3>
            {a.kind}: <code>{a.path}</code>{" "}
            <span className="muted">@{a.sha?.slice(0, 7) ?? "?"}</span>
          </h3>
          {a.html ? (
            <div className="markdown-body" dangerouslySetInnerHTML={{ __html: a.html }} />
          ) : (
            <p className="muted">Content not cached yet — run a reconcile.</p>
          )}
        </div>
      ))}

      {g.gate === "release" && (
        <div className="card">
          <h3>Release train — the merge button is the gate</h3>
          {g.releasePrs.length === 0 && <p className="muted">No open promotion or task PRs found.</p>}
          {g.releasePrs.map((pr) => (
            <div className="spread" key={pr.id} style={{ padding: "0.35rem 0" }}>
              <span>
                <span className="badge">{pr.kind}</span> #{pr.number} {pr.title}{" "}
                <span className="muted">(CI: {pr.ciStatus ?? "unknown"})</span>
                <a className="raw-link" href={pr.htmlUrl} target="_blank" rel="noreferrer">
                  ≡ raw
                </a>
              </span>
              {g.amApprover && (
                <button className="approve" disabled={merge.isPending || pr.ciStatus === "failure"} onClick={() => merge.mutate(pr.id)}>
                  Merge as @{me.login}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {g.commentApprovable && g.amApprover && (
        <div className="card">
          <h3>Decide</h3>
          {g.openQuestions.length > 0 && (
            <div className="banner stale">
              <strong>{g.openQuestions.length} open question(s)</strong> on this gate's artifacts:
              <ul style={{ margin: "0.4rem 0" }}>
                {g.openQuestions.map((t) => (
                  <li key={t.id}>
                    {t.title} ({t.entryCount} entries)
                  </li>
                ))}
              </ul>
              <label>
                <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={ack} onChange={(e) => setAck(e.target.checked)} />
                Approve anyway — this acknowledgement is recorded in the audit log
              </label>
            </div>
          )}
          <div className="row">
            <button
              className="approve"
              disabled={approve.isPending || (g.openQuestions.length > 0 && !ack)}
              onClick={() => approve.mutate()}
              title='Posts the literal comment "Approved" on the epic as you'
            >
              {approve.isPending ? "Posting…" : `Approve as @${me.login}`}
            </button>
            <button onClick={() => setShowRequest(!showRequest)}>Request changes</button>
          </div>
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            Approve posts the literal comment <code>Approved</code> under your GitHub identity; the factory router merges the
            document PR and advances the pipeline exactly as if you had typed it on GitHub.
          </p>
          {showRequest && (
            <div style={{ marginTop: "0.5rem" }}>
              <textarea
                value={requestBody}
                onChange={(e) => setRequestBody(e.target.value)}
                placeholder="What needs to change before this can be approved?"
              />
              <button
                className="primary"
                style={{ marginTop: "0.4rem" }}
                disabled={!requestBody.trim() || requestChanges.isPending}
                onClick={() => requestChanges.mutate()}
              >
                Post comment
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TasksTab({ data }: { data: EpicWorkspace }) {
  const cols: Array<{ title: string; match: (s: string | null, open: boolean) => boolean }> = [
    { title: "Waiting", match: (s, open) => open && (s === null || s === "factory:design-approved") },
    { title: "Ready", match: (s, open) => open && s === "factory:ready" },
    { title: "In review", match: (s, open) => open && s === "factory:in-review" },
    { title: "In test", match: (s, open) => open && s === "factory:in-test" },
    { title: "Ship/Done", match: (s, open) => !open || s === "factory:ready-to-ship" || s === "factory:deployed" },
    { title: "Blocked", match: (s, open) => open && s === "factory:blocked" },
  ];
  if (data.tasks.length === 0) return <p className="muted">No task sub-issues yet — tasks appear after the plan (G1) is approved and the planner runs.</p>;
  return (
    <div className="board">
      {cols.map((c) => {
        const items = data.tasks.filter((t) => c.match(t.state, t.open));
        return (
          <div className="board-col" key={c.title}>
            <h4>
              {c.title} ({items.length})
            </h4>
            {items.map((t) => (
              <div className={`board-card${t.state === "factory:blocked" ? " blocked" : ""}`} key={t.id}>
                #{t.number} {t.title.replace(/^task\([^)]*\):?\s*/i, "")}
                <div className="meta">
                  {t.blockedBy.filter((d) => d.open).length > 0 && (
                    <span title={t.blockedBy.filter((d) => d.open).map((d) => `#${d.number} ${d.title}`).join("\n")}>
                      ⛓ after {t.blockedBy.filter((d) => d.open).map((d) => `#${d.number}`).join(", ")}
                    </span>
                  )}
                  {t.blocks.length > 0 && (
                    <span title={t.blocks.map((d) => `#${d.number} ${d.title}`).join("\n")}>
                      unblocks {t.blocks.map((d) => `#${d.number}`).join(", ")}
                    </span>
                  )}
                  <a href={t.htmlUrl} target="_blank" rel="noreferrer" className="raw-link">
                    ≡ raw
                  </a>
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ThreadsTab({ data }: { data: EpicWorkspace }) {
  const [openThread, setOpenThread] = useState<string | null>(null);
  const nonEmpty = data.threads.filter((t) => Number(t.entryCount) > 0 || t.topicKind === "free");
  const empty = data.threads.filter((t) => Number(t.entryCount) === 0 && t.topicKind !== "free");
  return (
    <div>
      {nonEmpty.map((t) => (
        <ThreadCard key={t.id} threadId={t.id} summary={t} expanded={openThread === t.id} onToggle={() => setOpenThread(openThread === t.id ? null : t.id)} />
      ))}
      {empty.length > 0 && (
        <p className="muted">
          Empty threads: {empty.map((t) => t.title).join(" · ")} — they fill as conversation happens on GitHub or here.
        </p>
      )}
    </div>
  );
}

function ThreadCard({
  threadId,
  summary,
  expanded,
  onToggle,
}: {
  threadId: string;
  summary: { title: string; status: string; entryCount: number; topicRef: string };
  expanded: boolean;
  onToggle: () => void;
}) {
  const qc = useQueryClient();
  const thread = useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => api.get<ThreadDetail>(`/api/threads/${threadId}`),
    enabled: expanded,
  });
  const [body, setBody] = useState("");
  const [privateNote, setPrivateNote] = useState(false);

  const post = useMutation({
    mutationFn: () => api.post(`/api/threads/${threadId}/entries`, { body, privateNote }),
    onSuccess: () => {
      setBody("");
      void qc.invalidateQueries({ queryKey: ["thread", threadId] });
    },
  });
  const setStatus = useMutation({
    mutationFn: (status: "open" | "resolved") => api.post(`/api/threads/${threadId}/status`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["epic"] }),
  });

  return (
    <div className="card">
      <div className="spread" style={{ cursor: "pointer" }} onClick={onToggle}>
        <h3 style={{ margin: 0 }}>
          {summary.status === "resolved" ? "✓ " : ""}
          {summary.title} <span className="muted">({summary.entryCount})</span>
        </h3>
        <span className="muted">{expanded ? "▾" : "▸"}</span>
      </div>
      {expanded && thread.data && (
        <div style={{ marginTop: "0.5rem" }}>
          {thread.data.entries.map((e) => (
            <div className="thread-entry" key={e.id}>
              <div className="head">
                <span className="author">@{e.author ?? "?"}</span>
                {e.isAgent && <span className="badge">agent</span>}
                {e.isApproval && <span className="badge merge">Approved</span>}
                {e.source === "console_note" && <span className="badge">private note</span>}
                <span>{new Date(e.createdAt).toLocaleString()}</span>
                {e.htmlUrl && (
                  <a className="raw-link" href={e.htmlUrl} target="_blank" rel="noreferrer">
                    ≡ raw
                  </a>
                )}
              </div>
              <div className="markdown-body" dangerouslySetInnerHTML={{ __html: e.bodyHtml }} />
            </div>
          ))}
          <div style={{ marginTop: "0.6rem" }}>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Reply — posts to GitHub as you, threaded here." />
            {post.isError && <div className="banner error">{(post.error as Error).message}</div>}
            <div className="row" style={{ marginTop: "0.4rem" }}>
              <button className="primary" disabled={!body.trim() || post.isPending} onClick={() => post.mutate()}>
                {post.isPending ? "Posting…" : privateNote ? "Save private note" : "Post to GitHub"}
              </button>
              <label className="muted">
                <input type="checkbox" style={{ width: "auto", marginRight: 5 }} checked={privateNote} onChange={(e) => setPrivateNote(e.target.checked)} />
                private note (never posted)
              </label>
              <span style={{ flex: 1 }} />
              <button onClick={() => setStatus.mutate(summary.status === "open" ? "resolved" : "open")}>
                {summary.status === "open" ? "Resolve" : "Reopen"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DecisionsTab({ epicId }: { epicId: string }) {
  const qc = useQueryClient();
  const decisions = useQuery({
    queryKey: ["decisions", epicId],
    queryFn: () => api.get<{ decisions: Decision[] }>(`/api/epics/${epicId}/decisions`),
  });
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ title: "", context: "", options: "", chosen: "", consequences: "" });

  const create = useMutation({
    mutationFn: () =>
      api.post(`/api/epics/${epicId}/decisions`, {
        title: form.title,
        context: form.context || undefined,
        options: form.options ? form.options.split("\n").filter(Boolean) : [],
        chosen: form.chosen || undefined,
        consequences: form.consequences || undefined,
      }),
    onSuccess: () => {
      setShow(false);
      setForm({ title: "", context: "", options: "", chosen: "", consequences: "" });
      void qc.invalidateQueries({ queryKey: ["decisions", epicId] });
    },
  });

  return (
    <div>
      <div className="spread" style={{ marginBottom: "0.75rem" }}>
        <p className="muted" style={{ margin: 0 }}>
          Decisions post to the epic as structured comments — findable here, readable by everyone on GitHub.
        </p>
        <button className="primary" onClick={() => setShow(!show)}>
          New decision
        </button>
      </div>
      {show && (
        <div className="card">
          <h3>Record a decision</h3>
          <p>
            <input placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </p>
          <p>
            <textarea placeholder="Context — what raised this?" value={form.context} onChange={(e) => setForm({ ...form, context: e.target.value })} />
          </p>
          <p>
            <textarea placeholder="Options considered (one per line)" value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} />
          </p>
          <p>
            <input placeholder="Chosen option" value={form.chosen} onChange={(e) => setForm({ ...form, chosen: e.target.value })} />
          </p>
          <p>
            <textarea placeholder="Consequences" value={form.consequences} onChange={(e) => setForm({ ...form, consequences: e.target.value })} />
          </p>
          {create.isError && <div className="banner error">{(create.error as Error).message}</div>}
          <button className="primary" disabled={!form.title.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Posting…" : "Decide & post to GitHub"}
          </button>
        </div>
      )}
      {decisions.data?.decisions.map((d) => (
        <DecisionCard key={d.id} d={d} />
      ))}
      {decisions.data?.decisions.length === 0 && <p className="muted">No decisions yet. Gate approvals record themselves here automatically.</p>}
    </div>
  );
}

function TimelineRail({ epicId }: { epicId: string }) {
  const timeline = useQuery({
    queryKey: ["timeline", epicId],
    queryFn: () => api.get<{ events: TimelineEvent[] }>(`/api/epics/${epicId}/timeline`),
  });
  return (
    <div className="card">
      <h3>Timeline</h3>
      {timeline.data?.events.slice(0, 30).map((e, i) => (
        <div className="timeline-event" key={i}>
          <span className="at">{new Date(e.at).toLocaleDateString()}</span>
          <span>
            {e.detail}
            {e.actor && <span className="muted"> — @{e.actor}</span>}
            {e.link && (
              <a className="raw-link" href={e.link} target="_blank" rel="noreferrer">
                ≡
              </a>
            )}
          </span>
        </div>
      ))}
      {timeline.data?.events.length === 0 && <p className="muted">No events yet.</p>}
    </div>
  );
}
