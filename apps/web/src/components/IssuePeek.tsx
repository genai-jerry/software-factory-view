import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { QaPanel } from "../pages/QaPanel.js";
import { RepoChip } from "./RepoChip.js";
import { GitHubLink } from "./GitHubLink.js";
import { Sheet } from "./Sheet.js";
import { ActionBar } from "./ActionBar.js";
import { PHASE_LABELS, peopleLabel } from "../lib/labels.js";
import type { DepNode, IssuePeekData } from "../types.js";

export function IssuePeek({ issueId, onClose }: { issueId: string; onClose: () => void }) {
  const [focusId, setFocusId] = useState(issueId);
  const peek = useQuery({
    queryKey: ["peek", focusId],
    queryFn: () => api.get<IssuePeekData>(`/api/issues/${focusId}/peek`),
  });

  return (
    <Sheet title={peek.data ? `#${peek.data.issue.number} ${peek.data.issue.title}` : "Issue"} onClose={onClose}>
      {peek.isLoading && <p className="muted">Loading…</p>}
      {peek.isError && <p className="muted">Could not load this issue.</p>}
      {peek.data && <PeekBody data={peek.data} onFocus={setFocusId} onClose={onClose} />}
    </Sheet>
  );
}

function PeekBody({ data, onFocus, onClose }: { data: IssuePeekData; onFocus: (id: string) => void; onClose: () => void }) {
  const { issue } = data;
  return (
    <div>
      <div className="row" style={{ margin: "0 0 0.5rem" }}>
        <span className="badge state">{peopleLabel(issue.state)}</span>
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
            <span>Agent halted — a reply is needed to continue.</span>
          )}
          {data.blocked.since && <span className="muted"> (since {new Date(data.blocked.since).toLocaleDateString()})</span>}
        </div>
      )}
      {data.blocked && <ReplyBox issueId={issue.id} />}

      {data.prs.length > 0 && (
        <div style={{ marginTop: "0.75rem" }}>
          <h4 className="muted" style={{ margin: "0 0 0.35rem" }}>
            Open pull requests
          </h4>
          {data.prs.map((pr) => (
            <p style={{ margin: "0 0 0.25rem" }} key={pr.number}>
              <a href={pr.htmlUrl} target="_blank" rel="noreferrer">
                PR #{pr.number} {pr.title}
              </a>{" "}
              <span className="muted">
                {pr.draft ? "in draft" : "awaiting merge"}
                {pr.ciStatus && ` · CI ${pr.ciStatus}`}
              </span>
            </p>
          ))}
        </div>
      )}

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
        <GitHubLink href={issue.htmlUrl} />
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
      <span className="muted">{label}</span>
      {nodes.map((n) => (
        <button className={`dep-node${n.open ? "" : " done"}`} key={n.id} onClick={() => onFocus(n.id)} title={n.title}>
          {n.open ? (n.state === "factory:blocked" ? "halted" : "open") : "done"} #{n.number}
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
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Reply to unblock — posts as you on GitHub"
        enterKeyHint="send"
      />
      <ActionBar>
        <button className="primary" disabled={!body.trim() || reply.isPending} onClick={() => reply.mutate()}>
          {reply.isPending ? "Posting…" : "Reply & resume"}
        </button>
      </ActionBar>
      {reply.isError && <p className="muted">Reply failed — try again.</p>}
    </div>
  );
}
