import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import type { EpicTree, TreeDep, TreeNode } from "../types.js";
import { GitHubLink } from "../components/GitHubLink.js";
import { RepoChip } from "../components/RepoChip.js";
import { peopleLabel } from "../lib/labels.js";
import { START_STATUS_LABEL, TaskStartGate } from "../components/Approve.js";
import { NextStepLine, StartRoleButton } from "../components/NextStep.js";

/**
 * The epic's dependency tree (plan 11 §1): tasks laid out in dependency waves
 * — wave 1 has no open prerequisites, each later wave waits on the ones above
 * — with the actions that unstick a node right on it: Approve for a ready
 * task (the start gate, the shared button every tab renders), a comment box
 * for anything else, and the epic's own gate handed off to the gate panel.
 */

export function DependencyTreeTab({ epicId, onOpenGate }: { epicId: string; onOpenGate: () => void }) {
  const tree = useQuery({
    queryKey: ["tree", epicId],
    queryFn: () => api.get<EpicTree>(`/api/epics/${epicId}/tree`),
    refetchInterval: 30_000,
  });

  if (tree.isError) return <div className="banner error">{(tree.error as ApiError).message}</div>;
  if (!tree.data) return <p className="muted">Loading tree…</p>;
  const data = tree.data;
  if (data.nodes.length === 0) {
    return <p className="muted">No task sub-issues yet — the tree grows when the planner fans the epic out after G1.</p>;
  }

  const waves = intoWaves(data.nodes);
  return (
    <div className="dep-tree">
      <div className="dep-node dep-epic">
        <div className="dep-node-head">
          <strong>
            Epic #{data.epic.number} · {data.epic.title}
          </strong>
          <span className="badge state">{peopleLabel(data.epic.state)}</span>
          <GitHubLink href={data.epic.htmlUrl} />
        </div>
        {data.epic.gate && (
          <div className="dep-actions">
            <span className="muted">{data.epic.gate.label} is open on this epic.</span>
            <button type="button" onClick={onOpenGate}>
              Open the gate panel
            </button>
          </div>
        )}
      </div>
      {waves.map((wave, i) => (
        <div className="dep-wave" key={i}>
          <div className="dep-wave-label">
            {i === 0 ? "Wave 1 — no prerequisites" : `Wave ${i + 1} — after wave ${i}`}
          </div>
          <div className="dep-wave-nodes">
            {wave.map((n) => (
              <TreeNodeCard key={n.id} epicId={epicId} node={n} startGate={data.startGate} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Kahn layering over the in-tree blocked-by edges. Closed blockers do not
 * hold a node back — the waves show what can start *now*, not the original
 * plan. A dependency cycle (drift) cannot layer; its members land together in
 * a final wave rather than vanishing.
 */
export function intoWaves(nodes: TreeNode[]): TreeNode[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const level = new Map<string, number>();
  const pending = new Set(nodes.map((n) => n.id));
  let depth = 0;
  while (pending.size > 0 && depth < nodes.length + 1) {
    const placeable = [...pending].filter((id) =>
      byId.get(id)!.blockedBy.every((d) => !d.inTree || !d.open || !pending.has(d.id)),
    );
    if (placeable.length === 0) break; // cycle — dump the rest below
    for (const id of placeable) {
      level.set(id, depth);
      pending.delete(id);
    }
    depth += 1;
  }
  for (const id of pending) level.set(id, depth); // cycle members, together
  const out: TreeNode[][] = [];
  for (const n of nodes) {
    const l = level.get(n.id) ?? 0;
    while (out.length <= l) out.push([]);
    out[l]!.push(n);
  }
  return out.filter((w) => w.length > 0);
}

function TreeNodeCard({ epicId, node, startGate }: { epicId: string; node: TreeNode; startGate: EpicTree["startGate"] }) {
  const qc = useQueryClient();
  const [composerOpen, setComposerOpen] = useState(false);
  const [comment, setComment] = useState("");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["tree", epicId] });
    void qc.invalidateQueries({ queryKey: ["epic", epicId] });
  };
  const reply = useMutation({
    mutationFn: () => api.post<{ ok: boolean; commentUrl: string }>(`/api/issues/${node.id}/reply`, { body: comment }),
    onSuccess: () => {
      setComment("");
      setComposerOpen(false);
      refresh();
    },
  });

  const openBlockers = node.blockedBy.filter((d) => d.open);
  const doneBlockers = node.blockedBy.filter((d) => !d.open);
  const cls = ["dep-node", node.agentHalted ? "halted" : "", node.waiting ? "waiting" : "", !node.open ? "done" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} id={`dep-${node.id}`}>
      <div className="dep-node-head">
        <span>
          #{node.number} {node.title.replace(/^task\([^)]*\):?\s*/i, "")}
        </span>
        {node.crossRepo && <RepoChip fullName={node.repo} />}
        <span className={`badge ${!node.open ? "merge" : node.agentHalted ? "blocked" : node.approvable ? "task-start" : "state"}`}>
          {node.open ? (node.startStatus === "none" ? peopleLabel(node.state) : START_STATUS_LABEL[node.startStatus]) : "Done"}
        </span>
        <GitHubLink href={node.htmlUrl} />
      </div>
      {(node.blockedBy.length > 0 || node.blocks.length > 0 || node.assignees.length > 0) && (
        <div className="dep-chips">
          {openBlockers.map((d) => (
            <DepChip key={d.id} dep={d} nodeRepo={node.repo} kind="open" />
          ))}
          {doneBlockers.map((d) => (
            <DepChip key={d.id} dep={d} nodeRepo={node.repo} kind="done" />
          ))}
          {node.blocks.length > 0 && (
            <span className="dep-chip unblocks" title={node.blocks.map((d) => `#${d.number} ${d.title}`).join("\n")}>
              unblocks {node.blocks.map((d) => `#${d.number}`).join(", ")}
            </span>
          )}
          {node.assignees.length > 0 && <span className="muted">@{node.assignees.join(", @")}</span>}
        </div>
      )}
      {node.agentHalted && <div className="dep-halt">Agent halted — it needs a human reply to continue. Comment below.</div>}
      <NextStepLine step={node.nextStep} />
      <div className="dep-actions">
        <StartRoleButton issueId={node.id} step={node.nextStep} />
        <TaskStartGate
          epicId={epicId}
          taskId={node.id}
          number={node.number}
          startGate={startGate}
          status={node.startStatus}
        />
        <button type="button" onClick={() => setComposerOpen((v) => !v)}>
          {composerOpen ? "Cancel" : "Comment"}
        </button>
      </div>
      {composerOpen && (
        <div className="dep-composer">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder={`Comment on #${node.number} as you, on GitHub`}
          />
          <div className="row">
            <button type="button" disabled={!comment.trim() || reply.isPending} onClick={() => reply.mutate()}>
              {reply.isPending ? "Posting…" : "Post comment"}
            </button>
            {reply.isError && <span className="muted">{(reply.error as ApiError).message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function DepChip({ dep, nodeRepo, kind }: { dep: TreeDep; nodeRepo: string; kind: "open" | "done" }) {
  const label = `${kind === "open" ? "waiting on" : "✓"} ${dep.repo !== nodeRepo ? dep.repo : ""}#${dep.number}`;
  const title = `#${dep.number} ${dep.title}${dep.open ? ` — ${peopleLabel(dep.state)}` : " — done"}`;
  if (dep.inTree) {
    return (
      <a
        className={`dep-chip ${kind}`}
        href={`#dep-${dep.id}`}
        title={title}
        onClick={(e) => {
          e.preventDefault();
          document.getElementById(`dep-${dep.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
      >
        {label}
      </a>
    );
  }
  return (
    <a className={`dep-chip ${kind}`} href={dep.htmlUrl} target="_blank" rel="noreferrer" title={`${title} (outside this epic)`}>
      {label} ↗
    </a>
  );
}
