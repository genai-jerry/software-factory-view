import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { QaPanel } from "../pages/QaPanel.js";
import { RepoChip } from "./RepoChip.js";
import type { DepNode, IssuePeekData } from "../types.js";

const PHASE_LABELS: Record<string, string> = {
  specifying: "Being specified",
  planning: "Being planned",
  building: "Being built",
  shipping: "Shipping",
  held: "Held",
};

/**
 * The peek drawer (plan 07 §4.4): level two of row → peek → workspace. The
 * row is the headline, this is the paragraph — state in a sentence, who moves
 * it next, the one-hop dependency strip, the last meaningful event, and the
 * reply box when blocked. Clicking a dependency node re-peeks it in place.
 */
export function IssuePeek({ issueId, onClose }: { issueId: string; onClose: () => void }) {
  const [focusId, setFocusId] = useState(issueId);
  const peek = useQuery({
    queryKey: ["peek", focusId],
    queryFn: () => api.get<IssuePeekData>(`/api/issues/${focusId}/peek`),
  });

  return (
    <div className="peek-overlay" onClick={onClose}>
      <div className="peek" onClick={(e) => e.stopPropagation()}>
        {peek.isLoading && <p className="muted">Loading…</p>}
        {peek.isError && <p className="muted">Could not load this issue.</p>}
        {peek.data && <PeekBody data={peek.data} onFocus={setFocusId} onClose={onClose} />}
      </div>
    </div>
  );
}

function PeekBody({ data, onFocus, onClose }: { data: IssuePeekData; onFocus: (id: string) => void; onClose: () => void }) {
  const { issue } = data;
  return (
    <div>
      <div className="spread">
        <h3 style={{ margin: 0 }}>
          #{issue.number} {issue.title}
        </h3>
        <button onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="row" style={{ margin: "0.5rem 0" }}>
        <span className="badge state">{issue.state?.replace("factory:", "") ?? "no state"}</span>
        <span className="badge">{PHASE_LABELS[issue.phase]}</span>
        <RepoChip fullName={issue.repo} />
        {issue.assignees.map((a) => (
          <span className="chip" key={a}>
            @{a}
          </span>
        ))}
      </div>

      <p style={{ marginTop: "0.75rem" }}>{data.sentence}</p>
      {data.nextMover && (
        <p className="muted" style={{ marginTop: "0.25rem" }}>
          <strong>Next:</strong> {data.nextMover}
        </p>
      )}

      {data.blocked && (
        <div className="banner error" style={{ marginTop: "0.75rem" }}>
          {data.blocked.question ? (
            <span>
              The agent asked: <em>“{data.blocked.question}”</em>
            </span>
          ) : (
            <span>Blocked — the agent needs a reply to continue.</span>
          )}
          {data.blocked.since && <span className="muted"> (since {new Date(data.blocked.since).toLocaleDateString()})</span>}
        </div>
      )}
      {data.blocked && <ReplyBox issueId={issue.id} />}

      {(data.deps.blockedBy.length > 0 || data.deps.blocks.length > 0) && (
        <div style={{ marginTop: "1rem" }}>
          <h4 className="muted" style={{ margin: "0 0 0.35rem" }}>
            Dependencies
          </h4>
          {data.deps.blockedBy.length > 0 && <DepStrip label="Blocked by" nodes={data.deps.blockedBy} onFocus={onFocus} />}
          {data.deps.blocks.length > 0 && <DepStrip label="Blocks" nodes={data.deps.blocks} onFocus={onFocus} />}
        </div>
      )}

      {data.lastEvent && (
        <p className="muted" style={{ marginTop: "0.75rem" }}>
          Last move: {data.lastEvent.detail}
          {data.lastEvent.actor && ` by ${data.lastEvent.actor}`} · {new Date(data.lastEvent.at).toLocaleString()}
        </p>
      )}

      <div className="row" style={{ marginTop: "1rem" }}>
        <Link to={`/epics/${data.epicId}${issue.kind === "task" ? "?tab=tasks" : data.gate ? "?tab=gate" : ""}`} onClick={onClose}>
          <button className="primary">Open workspace</button>
        </Link>
        <a href={issue.htmlUrl} target="_blank" rel="noreferrer" className="raw-link">
          ≡ raw
        </a>
      </div>

      <div style={{ marginTop: "1rem" }}>
        <QaPanel scope={{ kind: "issue", id: issue.id }} />
      </div>
    </div>
  );
}

function DepStrip({ label, nodes, onFocus }: { label: string; nodes: DepNode[]; onFocus: (id: string) => void }) {
  return (
    <div className="row" style={{ marginBottom: "0.35rem" }}>
      <span className="muted" style={{ minWidth: "5.5rem" }}>
        {label}
      </span>
      {nodes.map((n) => (
        <button className={`dep-node${n.open ? "" : " done"}`} key={n.id} onClick={() => onFocus(n.id)} title={n.title}>
          {n.open ? (n.state === "factory:blocked" ? "⚠" : "●") : "✓"} #{n.number}
        </button>
      ))}
    </div>
  );
}

function ReplyBox({ issueId }: { issueId: string }) {
  const [body, setBody] = useState("");
  const qc = useQueryClient();
  const reply = useMutation({
    mutationFn: () => api.post(`/api/issues/${issueId}/reply`, { body }),
    onSuccess: () => {
      setBody("");
      void qc.invalidateQueries({ queryKey: ["my-work"] });
      void qc.invalidateQueries({ queryKey: ["peek", issueId] });
    },
  });
  return (
    <div style={{ marginTop: "0.5rem" }}>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Reply to unblock — posts as you on GitHub" />
      <button className="primary" style={{ marginTop: "0.4rem" }} disabled={!body.trim() || reply.isPending} onClick={() => reply.mutate()}>
        {reply.isPending ? "Posting…" : "Reply & resume"}
      </button>
      {reply.isError && <p className="muted">Reply failed — try again.</p>}
    </div>
  );
}
