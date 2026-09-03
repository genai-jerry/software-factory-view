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
  TaskStartStatus,
  ThreadDetail,
  TimelineEvent,
} from "../types.js";
import { DecisionCard } from "./Decisions.js";
import { DependencyTreeTab } from "./DependencyTree.js";
import { QaPanel } from "./QaPanel.js";
import { FactoryRunStatus } from "../components/FactoryRunStatus.js";
import { GitHubLink } from "../components/GitHubLink.js";
import { SegmentedTabs } from "../components/SegmentedTabs.js";
import { Sheet } from "../components/Sheet.js";
import { ActionBar } from "../components/ActionBar.js";
import { APPROVE_LABEL, START_STATUS_LABEL, startStatusTakesApproval, TaskStartGate } from "../components/Approve.js";
import { HaltBar } from "../components/HaltBar.js";
import { NextStepLine, StartRoleButton } from "../components/NextStep.js";
import { EXPEDITE_BADGE, EXPEDITE_TITLE, peopleLabel, factoryShort } from "../lib/labels.js";

type Tab = "overview" | "artifacts" | "gate" | "tree" | "tasks" | "threads" | "decisions";

const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  artifacts: "Spec",
  gate: "Gate",
  tree: "Tree",
  tasks: "Tasks",
  threads: "Threads",
  decisions: "Decisions",
};

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

  const [askOpen, setAskOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);

  if (ws.isError) return <div className="banner error">{(ws.error as ApiError).message}</div>;
  if (!ws.data) return <p className="muted">Loading workspace…</p>;
  const data = ws.data;

  // The states whose gate the Console can actually panel: G1, G2, GS and G3.
  // (`factory:ready` also carries a gate, but that one is the task start gate
  // and lives on the task rows.)
  const gateOpen =
    data.gate !== null &&
    (data.epic.state === "factory:spec-ready" ||
      data.epic.state === "factory:design-ready" ||
      data.epic.state === "factory:epic-ready" ||
      data.epic.state === "factory:in-staging");
  const readyTasks = data.tasks.filter((t) => t.approvable);
  const showHalt = gateOpen && data.gate!.amApprover && tab !== "gate";
  const tabItems: Array<{ id: Tab; label: string }> = (
    ["overview", "artifacts", ...(gateOpen ? (["gate"] as const) : []), "tree", "tasks", "threads", "decisions"] as Tab[]
  ).map((t) => ({
    id: t,
    label:
      t === "gate"
        ? `Gate (${peopleLabel(data.epic.state)})`
        : t === "threads"
          ? `Threads (${data.threads.filter((th) => Number(th.entryCount) > 0).length})`
          : TAB_LABELS[t],
  }));

  return (
    <div>
      <div className="spread">
        <h1 style={{ marginBottom: 0 }}>
          Epic #{data.epic.number} · {data.epic.title}{" "}
          <GitHubLink href={data.epic.htmlUrl} />
        </h1>
        <span className="row" style={{ alignItems: "center", gap: "0.4rem" }}>
          {data.expedite.on && (
            <span className="badge expedite" title={EXPEDITE_TITLE}>
              {EXPEDITE_BADGE}
            </span>
          )}
          <span className="badge state" title={data.epic.state ?? undefined}>
            {data.epic.status ?? peopleLabel(data.epic.state)}
          </span>
        </span>
      </div>

      <ExpediteToggle epicId={data.epic.id} expedite={data.expedite} />

      {/* The epic branch (FACTORY.md §6b) is named factory/epic-<epic issue
          number>. The Console cannot read the estate's branch policy, so it
          shows the name only when a factory:on-epic state proves the branch
          is in use for this epic. */}
      {(data.epic.state === "factory:on-epic" || data.tasks.some((t) => t.state === "factory:on-epic")) && (
        <p className="muted" style={{ marginTop: 4 }}>
          Assembling on epic branch <code>factory/epic-{data.epic.number}</code>
        </p>
      )}

      <StageRail pipeline={data.pipeline} current={data.epic.state} pendingMine={gateOpen && data.gate!.amApprover} expanded={railOpen} onToggle={() => setRailOpen((v) => !v)} />

      <FactoryRunStatus data={data} />

      {/* The epic's own "what now?", in the same words the factory posts on
          the issue. The tabs below answer it for the tasks. */}
      <div className="row" style={{ alignItems: "center", gap: "0.6rem" }}>
        <NextStepLine step={data.epic.nextStep} />
        <StartRoleButton issueId={data.epic.id} step={data.epic.nextStep} />
      </div>

      {showHalt && (
        <HaltBar
          title={peopleLabel(data.epic.state)}
          detail={`${data.gate!.label} is waiting on you.`}
          actionLabel="Open"
          onAction={() => setTab("gate")}
        />
      )}

      {data.freshness.stale && (
        <div className="banner stale">
          Last sync {data.freshness.lastSyncedAt ? new Date(data.freshness.lastSyncedAt).toLocaleString() : "never"} — this view
          may be stale.
        </div>
      )}
      {data.orchestrator.canStart && <StartFactoryRun epicId={data.epic.id} state={data.epic.state} />}
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
      {/* The task start gate, said once at the top the way the epic gate is:
          whichever tab you land on, the same Approve is one click away. */}
      {readyTasks.length > 0 && data.startGate.amApprover && tab !== "tasks" && (
        <div className="banner info">
          {readyTasks.length} task{readyTasks.length === 1 ? "" : "s"} waiting on your approval to start:{" "}
          {readyTasks.map((t) => `#${t.number}`).join(", ")}.{" "}
          <a
            onClick={(e) => {
              e.preventDefault();
              setTab("tasks");
            }}
            href="?tab=tasks"
          >
            Approve in Tasks →
          </a>
        </div>
      )}

      <SegmentedTabs ariaLabel="Epic workspace" items={tabItems} value={tab} onChange={setTab} />

      <div className="workspace workspace-wide">
        <div>
          {tab === "overview" && <OverviewTab data={data} />}
          {tab === "artifacts" && <ArtifactsTab data={data} />}
          {tab === "gate" && gateOpen && <GateTab epicId={data.epic.id} me={me} />}
          {tab === "tree" && <DependencyTreeTab epicId={data.epic.id} onOpenGate={() => setTab("gate")} />}
          {tab === "tasks" && <TasksTab data={data} />}
          {tab === "threads" && <ThreadsTab data={data} />}
          {tab === "decisions" && <DecisionsTab epicId={data.epic.id} />}
        </div>
        <div className="context-rail">
          <QaPanel scope={{ kind: "epic", id: data.epic.id }} />
          <TimelineRail epicId={data.epic.id} />
        </div>
      </div>
      <div className="workspace-tools">
        <button type="button" onClick={() => setAskOpen(true)}>
          Ask
        </button>
        <button type="button" onClick={() => setHistoryOpen(true)}>
          History
        </button>
      </div>
      {askOpen && (
        <Sheet title="Ask the Factory" onClose={() => setAskOpen(false)}>
          <QaPanel scope={{ kind: "epic", id: data.epic.id }} />
        </Sheet>
      )}
      {historyOpen && (
        <Sheet title="History" onClose={() => setHistoryOpen(false)}>
          <TimelineRail epicId={data.epic.id} />
        </Sheet>
      )}
    </div>
  );
}

/**
 * What expedite waives and what it keeps — the confirm step's whole content.
 *
 * Spelled out rather than summarised, because the switch is easy to flip and
 * its effect is invisible afterwards: from here on the factory approves and
 * starts things nobody was asked about. The right-hand list is why it is safe
 * to offer at all — nothing reaches staging, let alone production, without a
 * person saying so.
 */
const EXPEDITE_WAIVES = [
  "G1 — the spec gate: the factory approves it and starts the Planner",
  "G2 — the design gate: the factory approves it and releases the tasks",
  "Implementation starts: every task's Approve, on every task",
  "Review, QA and assembly starts: the factory runs each as the previous one lands",
];

const EXPEDITE_KEEPS = [
  "GS — the release to staging, at Epic ready: still your Approve",
  "G3 — the promotion to production: still a human merge on GitHub",
  "Anything an agent halts on: a blocked task still waits for your answer",
];

/**
 * The expedite toggle.
 *
 * Applying is a decision, so it takes a confirm that says exactly what it
 * waives; removing is not, so it does not. Either way the write is a label on
 * the epic, posted under the acting user's own GitHub identity — the factory
 * checks who applied it and reverts an application it does not accept, which
 * is only possible because the Console never applies it as the App.
 */
export function ExpediteToggle({ epicId, expedite }: { epicId: string; expedite: EpicWorkspace["expedite"] }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const flip = useMutation({
    mutationFn: (on: boolean) => api.post<{ ok: boolean; on: boolean }>(`/api/epics/${epicId}/expedite`, { on }),
    onSuccess: () => {
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ["epic", epicId] });
      void qc.invalidateQueries({ queryKey: ["tree", epicId] });
      void qc.invalidateQueries({ queryKey: ["timeline", epicId] });
      void qc.invalidateQueries({ queryKey: ["my-work"] });
    },
  });

  // The Console posted an application that is no longer on the issue: the
  // factory takes the marker back off when whoever applied it is not on its
  // list, and leaves its reason on the epic. Say so — silently reverting to an
  // off toggle reads as the button having done nothing.
  const reverted = !expedite.on && expedite.lastFlip?.on === true;

  return (
    <div className="expedite-toggle">
      <div className="row" style={{ alignItems: "center", gap: "0.6rem" }}>
        {expedite.on ? (
          <button type="button" disabled={!expedite.available || flip.isPending} onClick={() => flip.mutate(false)}>
            {flip.isPending ? "Turning off…" : "Turn expedite off"}
          </button>
        ) : (
          <button type="button" disabled={!expedite.available || flip.isPending} onClick={() => setConfirming(true)}>
            Expedite…
          </button>
        )}
        {expedite.reason && <span className="muted">{expedite.reason}</span>}
        {expedite.on && expedite.lastFlip?.on && (
          <span className="muted">
            on since {new Date(expedite.lastFlip.at).toLocaleDateString()}
            {expedite.lastFlip.actor && ` — @${expedite.lastFlip.actor}`}
          </span>
        )}
      </div>
      {reverted && (
        <div className="banner stale">
          Expedite was applied {expedite.lastFlip?.actor ? `by @${expedite.lastFlip.actor} ` : ""}on{" "}
          {new Date(expedite.lastFlip!.at).toLocaleString()}, but the marker is not on the issue now. The factory removes
          it when whoever applied it is not on its list — its comment on the epic says which.
        </div>
      )}
      {flip.isError && <div className="banner error">{(flip.error as ApiError).message}</div>}
      {confirming && (
        <Sheet title="Turn expedite on?" onClose={() => setConfirming(false)}>
          <p>
            The factory will run this epic without asking anyone to start each stage. Applied as you — GitHub records who
            asked for it.
          </p>
          <div className="card">
            <h3>It waives</h3>
            <ul>
              {EXPEDITE_WAIVES.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div className="card">
            <h3>It keeps</h3>
            <ul>
              {EXPEDITE_KEEPS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          {expedite.dormant && <div className="banner stale">{expedite.reason}</div>}
          <ActionBar>
            <button className="primary" disabled={flip.isPending} onClick={() => flip.mutate(true)}>
              {flip.isPending ? "Applying…" : "Turn expedite on"}
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </ActionBar>
        </Sheet>
      )}
    </div>
  );
}

function StartFactoryRun({ epicId, state }: { epicId: string; state: string | null }) {
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () =>
      api.post<{ queued: boolean; deliveryGuid: string; action: string; label: string | null }>(
        `/api/epics/${epicId}/factory-run`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["epic", epicId] });
      void queryClient.invalidateQueries({ queryKey: ["timeline", epicId] });
    },
  });
  const role =
    state === "factory:fast-track"
      ? "fast lane"
      : state === "factory:profile"
        ? "Profiler"
        : "factory";
  return (
    <div className="banner info">
      <p style={{ margin: "0 0 0.5rem" }}>
        GitHub delivered this issue to the Console, which only records it. The Software Factory
        orchestrator has not started the {role} yet.
      </p>
      <button onClick={() => start.mutate()} disabled={start.isPending}>
        {start.isPending ? "Starting…" : "Start factory run"}
      </button>
      {start.isError && <p className="muted">{(start.error as ApiError).message}</p>}
      {start.isSuccess && (
        <p className="muted">
          {start.data.queued ? "Queued with the orchestrator." : "The orchestrator already had this delivery."} Watch
          the issue on GitHub for the start comment.
        </p>
      )}
    </div>
  );
}

function StageRail({
  pipeline,
  current,
  pendingMine,
  expanded,
  onToggle,
}: {
  pipeline: string[];
  current: string | null;
  pendingMine: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const idx = current ? pipeline.indexOf(current) : -1;
  const compactIds = new Set([pipeline[idx - 1], pipeline[idx], pipeline[idx + 1]].filter(Boolean));
  return (
    <div>
      <div className={`stage-rail${expanded ? "" : " compact"}`}>
        {pipeline.map((s, i) => {
          const cls = i < idx ? "past" : i === idx ? (pendingMine ? "attention" : "current") : "";
          const shown = expanded || compactIds.has(s);
          return (
            <span className={`stage ${cls}${shown ? " shown" : ""}`} key={s} title={s}>
              {i > 0 && <span className="bar" />}
              <span className="dot" />
              <span className="lbl">
                {peopleLabel(s)}
                {factoryShort(s) && factoryShort(s) !== peopleLabel(s).replace(/\s/g, "") && (
                  <span className="muted"> ({factoryShort(s)})</span>
                )}
              </span>
            </span>
          );
        })}
        {current && idx === -1 && <span className="badge blocked">{peopleLabel(current)}</span>}
      </div>
      <button type="button" className="link" onClick={onToggle}>
        {expanded ? "Hide full pipeline" : "Show full pipeline"}
      </button>
    </div>
  );
}

function OverviewTab({ data }: { data: EpicWorkspace }) {
  const awaitingApproval = data.tasks.filter((t) => t.approvable).length;
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
            {/* The rollup counts the state; the amber only belongs on the
                tasks still waiting on a person, not on the ones an
                implementer already has. */}
            <span
              className={`badge ${awaitingApproval > 0 ? "task-start" : ""}`}
              title={
                awaitingApproval > 0
                  ? `${awaitingApproval} waiting on an implementation start`
                  : "all approved — the factory has them"
              }
            >
              {data.rollup.ready} ready
            </span>
            <span className="badge">{data.rollup.inReview} in review</span>
            <span className="badge">{data.rollup.inTest} in test</span>
            {/* Green and merged onto the epic branch, waiting for the rest of
                the epic (§6a, §6b). It appears in no other badge here, so
                without this a task that has passed review and QA reads as one
                nothing has happened to. */}
            {data.rollup.shipping > 0 && (
              <span className="badge" title="green and on the epic branch, waiting for the rest of the epic">
                {data.rollup.shipping} shipping
              </span>
            )}
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
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {data.artifacts.map((a) => (
            <option key={a.path} value={a.path}>
              [{a.kind}] {a.path}
              {a.diverged ? "  (proposed ≠ approved)" : ""}
            </option>
          ))}
        </select>
      </div>
      <SegmentedTabs
        ariaLabel="Artefact version"
        items={[
          { id: "proposed", label: "As proposed" },
          { id: "approved", label: "As approved" },
        ]}
        value={ref}
        onChange={setRef}
      />
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

/** What each gate is called in the panel's own heading. */
const GATE_TITLE: Record<string, string> = {
  spec: "spec gate",
  design: "design gate",
  implementation: "implementation start",
  staging: "release to staging",
  release: "promotion to production",
};

export function GateTab({ epicId, me }: { epicId: string; me: Me }) {
  const qc = useQueryClient();
  const gate = useQuery({
    queryKey: ["gate", epicId],
    queryFn: () => api.get<GatePanelData>(`/api/epics/${epicId}/gate`),
    retry: false,
  });
  const [requestBody, setRequestBody] = useState("");
  const [showRequest, setShowRequest] = useState(false);
  const [ack, setAck] = useState(false);
  // `what` names the action that failed, so the message reads as feedback on
  // the button that was actually pressed.
  const [actionError, setActionError] = useState<{ what: string; message: string } | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  // Open questions the server refused over that the panel had not listed — the
  // approve guard is authoritative, so its count re-enables the acknowledgement.
  const [serverOpenQuestions, setServerOpenQuestions] = useState<number | null>(null);

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
      setServerOpenQuestions(null);
      void qc.invalidateQueries({ queryKey: ["epic", epicId] });
      void qc.invalidateQueries({ queryKey: ["gate", epicId] });
    },
    onError: (e) => {
      const err = e as ApiError;
      const body = err.body as { openQuestionCount?: number } | null;
      if (err.status === 409 && typeof body?.openQuestionCount === "number") {
        // The guard found questions the panel did not show. Offer the
        // acknowledgement anyway, and refetch so they are listed.
        setServerOpenQuestions(body.openQuestionCount);
        void qc.invalidateQueries({ queryKey: ["gate", epicId] });
      }
      setActionError({ what: "Approval was not posted", message: err.message });
    },
  });

  const requestChanges = useMutation({
    mutationFn: () => api.post(`/api/epics/${epicId}/gate/request-changes`, { body: requestBody }),
    onSuccess: () => {
      setActionOk("Comment posted.");
      setShowRequest(false);
      setRequestBody("");
      setActionError(null);
    },
    onError: (e) => setActionError({ what: "Comment was not posted", message: (e as ApiError).message }),
  });

  const merge = useMutation({
    mutationFn: (prId: string) => api.post(`/api/prs/${prId}/merge`),
    onSuccess: () => {
      setActionOk("Merged.");
      setActionError(null);
      void qc.invalidateQueries({ queryKey: ["gate", epicId] });
    },
    onError: (e) => setActionError({ what: "Merge failed", message: (e as ApiError).message }),
  });

  if (gate.isError) return <div className="banner error">{(gate.error as ApiError).message}</div>;
  if (!gate.data) return <p className="muted">Loading gate panel…</p>;
  const g = gate.data;
  const openQuestionCount = Math.max(g.openQuestions.length, serverOpenQuestions ?? 0);
  const needsAck = openQuestionCount > 0;
  // The Decide card carries its own feedback; the top banner is for the release
  // gate's merge buttons, which are the only actions shown without it.
  const showDecide = g.commentApprovable && g.amApprover;

  return (
    <div>
      {!showDecide && actionOk && <div className="banner info">{actionOk}</div>}
      {!showDecide && actionError && (
        <div className="banner error">
          {actionError.what} — {actionError.message}
        </div>
      )}

      <div className="card">
        <div className="spread">
          <h3 style={{ margin: 0 }}>
            {g.label} — {GATE_TITLE[g.gate] ?? `${g.gate} gate`}
          </h3>
          <span className="muted">
            approvers:{" "}
            {g.approvers.length === 0 ? "any collaborator (empty list)" : g.approvers.map((a) => `@${a}`).join(", ")}
            {/* GS is newer than most approver files: where an estate has no
                `staging` list, the factory reads `release` instead, and the
                panel has to say whose list it is showing. */}
            {g.approversFrom && ` (no ${g.gate} list here — the ${g.approversFrom} approvers stand in)`}
          </span>
        </div>
        {g.gate === "staging" && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Approving releases this epic to the integration branch — <strong>staging, not production</strong>. G3 still
            holds afterwards, and nothing ships until a human merges the promotion PR there.
          </p>
        )}
        {g.changedSinceLastView && (
          <div className="banner stale">
            This spec changed since you last looked (you saw <code>{g.lastViewedSha?.slice(0, 7)}</code>, it is now{" "}
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
              <GitHubLink href={pr.htmlUrl} />
            </p>
          ))}
        </div>
      )}

      {/* GS decides on an assembly, not on a document: what the factory built,
          what it said about it, and whether every task actually landed. */}
      {g.assembly && (
        <div className="card">
          <div className="spread">
            <h3 style={{ margin: 0 }}>What was assembled</h3>
            <span className={`badge ${g.assembly.allGreen ? "merge" : "task-start"}`}>
              {g.assembly.allGreen ? "all tasks landed" : "not every task has landed"}
            </span>
          </div>
          <table className="assembly-table">
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {g.assembly.tasks.map((t) => (
                <tr key={t.number}>
                  <td>
                    #{t.number} {t.title.replace(/^task\([^)]*\):?\s*/i, "")} <GitHubLink href={t.htmlUrl} />
                  </td>
                  <td>{t.open ? peopleLabel(t.state) : "Done"}</td>
                </tr>
              ))}
              {g.assembly.tasks.length === 0 && (
                <tr>
                  <td colSpan={2} className="muted">
                    No task sub-issues projected for this epic.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {g.assembly.prs.length > 0 && (
            <p className="muted">
              Open against this epic:{" "}
              {g.assembly.prs.map((pr) => (
                <span key={pr.id}>
                  #{pr.number} {pr.title} (CI: {pr.ciStatus ?? "unknown"}) <GitHubLink href={pr.htmlUrl} />{" "}
                </span>
              ))}
            </p>
          )}
          {g.assembly.report ? (
            <>
              <h4>
                Latest factory report{g.assembly.report.author && <span className="muted"> — @{g.assembly.report.author}</span>}{" "}
                <span className="muted">{new Date(g.assembly.report.at).toLocaleString()}</span>
                {g.assembly.report.htmlUrl && <GitHubLink href={g.assembly.report.htmlUrl} />}
              </h4>
              <div className="markdown-body" dangerouslySetInnerHTML={{ __html: g.assembly.report.html }} />
            </>
          ) : (
            <p className="muted">
              No agent report on this epic yet — the assembly and suite results are on the epic branch's checks.
            </p>
          )}
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
                <GitHubLink href={pr.htmlUrl} />
              </span>
              {g.amApprover && (
                <ActionBar>
                  <button className="approve" disabled={merge.isPending || pr.ciStatus === "failure"} onClick={() => merge.mutate(pr.id)}>
                    Merge as @{me.login}
                  </button>
                </ActionBar>
              )}
            </div>
          ))}
        </div>
      )}

      {showDecide && (
        <div className="card">
          <h3>Decide</h3>
          {needsAck && (
            <div className="banner stale">
              <strong>{openQuestionCount} open question(s)</strong> on this gate's artifacts:
              {g.openQuestions.length > 0 ? (
                <ul style={{ margin: "0.4rem 0" }}>
                  {g.openQuestions.map((t) => (
                    <li key={t.id}>
                      {t.title} ({t.entryCount} entries)
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ margin: "0.4rem 0" }}>See the Threads tab for the details.</p>
              )}
              <label>
                <input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={ack} onChange={(e) => setAck(e.target.checked)} />
                Approve anyway — this acknowledgement is recorded in the audit log
              </label>
            </div>
          )}
          <ActionBar>
            <button
              className="approve"
              disabled={approve.isPending || (needsAck && !ack)}
              onClick={() => approve.mutate()}
              title={`Posts the literal comment "Approved" on the epic as @${me.login}`}
            >
              {approve.isPending ? "Approving…" : APPROVE_LABEL}
            </button>
            <button onClick={() => setShowRequest(!showRequest)}>Request changes</button>
          </ActionBar>
          {/* Beside the control that produced it: the Decide card sits below a
              full rendered spec, so a banner at the top of the tab is off-screen
              and a failed approve reads as the button doing nothing. */}
          {actionError && (
            <div className="banner error" style={{ marginTop: "0.5rem" }}>
              {actionError.what} — {actionError.message}
            </div>
          )}
          {actionOk && (
            <div className="banner info" style={{ marginTop: "0.5rem" }}>
              {actionOk}
            </div>
          )}
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            {g.gate === "staging" ? (
              <>
                Approve posts the literal comment <code>Approved</code> under your GitHub identity; the factory router
                merges the epic onto the integration branch and verifies it there, exactly as if you had typed it on
                GitHub. This is the release to staging — production is still gate G3.
              </>
            ) : (
              <>
                Approve posts the literal comment <code>Approved</code> under your GitHub identity; the factory router
                merges the document PR and advances the pipeline exactly as if you had typed it on GitHub.
              </>
            )}
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

/**
 * The task list. A task at `factory:ready` carries the same Approve button it
 * carries in the Tree and on its thread — the list is where most people look
 * first, and a ready task with no button there reads as "nothing to do".
 */
export function TasksTab({ data }: { data: EpicWorkspace }) {
  // `factory:ready` is two columns, not one: a task nobody has approved is
  // waiting on a person, and one that has been approved is waiting on the
  // factory. Filed under one heading, the second kind reads as work still
  // owed — which is how the same task got approved twice.
  type Task = EpicWorkspace["tasks"][number];
  const cols: Array<{ title: string; match: (t: Task) => boolean }> = [
    { title: "Waiting", match: (t) => t.open && (t.state === null || t.state === "factory:design-approved") },
    // An expedited task belongs under Ready, not Building: it is released and
    // nothing is running on it yet — the difference from the column next door
    // is only that the factory, not a person, presses the start.
    { title: "Ready", match: (t) => t.open && t.state === "factory:ready" && (t.approvable || t.startStatus === "auto") },
    { title: "Building", match: (t) => t.open && t.state === "factory:ready" && !t.approvable && t.startStatus !== "auto" },
    { title: "In review", match: (t) => t.open && t.state === "factory:in-review" },
    { title: "In test", match: (t) => t.open && t.state === "factory:in-test" },
    { title: "Ship/Done", match: (t) => !t.open || t.state === "factory:ready-to-ship" || t.state === "factory:on-epic" || t.state === "factory:in-staging" || t.state === "factory:deployed" },
    { title: "Blocked", match: (t) => t.open && t.state === "factory:blocked" },
  ];
  if (data.tasks.length === 0) return <p className="muted">No task sub-issues yet — tasks appear after the plan (G1) is approved and the planner runs.</p>;
  // System test cases (FACTORY.md §4b) are children of the epic like tasks,
  // but they are not tasks: no implementer runs on one, and what they want is
  // a human's verdict. Grouped apart so the columns keep meaning what they
  // say — a case in "Waiting" would read as work the factory owes.
  const cases = data.tasks.filter((t) => t.kind === "test");
  const codeTasks = data.tasks.filter((t) => t.kind !== "test");
  const approvable = codeTasks.filter((t) => t.approvable);
  const started = codeTasks.filter((t) => t.startStatus === "approved" || t.startStatus === "running");
  return (
    <div className="tasks-list">
      {/* Expedited: say once, at the top, why no row is asking for anything.
          Without this the list reads as a board nobody is working. */}
      {data.expedite.on && (
        <div className="banner info">
          <span className="badge expedite" title={EXPEDITE_TITLE}>
            {EXPEDITE_BADGE}
          </span>{" "}
          The factory starts each task&apos;s implementer, reviewer, QA and assembly itself. Nothing here needs your
          approval — the next decision is gate GS, when the epic is assembled.
        </div>
      )}
      {approvable.length > 0 && (
        <div className="banner info">
          {approvable.length} task{approvable.length === 1 ? "" : "s"} ready to build —{" "}
          {data.startGate.amApprover
            ? "Approve to start the implementer."
            : `waiting on ${data.startGate.approvers.map((a) => `@${a}`).join(", ")} to approve.`}
        </div>
      )}
      {approvable.length === 0 && started.length > 0 && (
        <div className="banner info">
          {started.length} approved task{started.length === 1 ? "" : "s"} in the factory&apos;s hands —{" "}
          {started.map((t) => `#${t.number}`).join(", ")}. Nothing to approve.
        </div>
      )}
      {/* A task in a state no column names (an epic-only state on a task,
          drift, a label applied by hand) used to vanish from the list
          entirely. Anything left over lands in the last group instead —
          losing a task off the board is worse than an odd heading. */}
      {[...cols, { title: "Elsewhere", match: (t: Task) => !cols.some((c) => c.match(t)) }].map((c) => {
        const items = codeTasks.filter((t) => c.match(t));
        if (items.length === 0) return null;
        return (
          <div key={c.title}>
            <h4 className="phase-head">
              {c.title} ({items.length})
            </h4>
            {items.map((t) => (
              <div className={`board-card${t.state === "factory:blocked" ? " blocked" : ""}`} key={t.id}>
                #{t.number} {t.title.replace(/^task\([^)]*\):?\s*/i, "")}
                <div className="meta">
                  {/* Same badge vocabulary as the Tree and the thread cards. */}
                  <span
                    className={`badge ${
                      !t.open
                        ? "merge"
                        : t.state === "factory:blocked"
                          ? "blocked"
                          : t.approvable
                            ? "task-start"
                            : t.startStatus === "auto"
                              ? "expedite"
                              : "state"
                    }`}
                  >
                    {t.open ? (t.startStatus === "none" ? peopleLabel(t.state) : START_STATUS_LABEL[t.startStatus]) : "Done"}
                  </span>
                  {t.blockedBy.filter((d) => d.open).length > 0 && (
                    <span title={t.blockedBy.filter((d) => d.open).map((d) => `#${d.number} ${d.title}`).join("\n")}>
                      after {t.blockedBy.filter((d) => d.open).map((d) => `#${d.number}`).join(", ")}
                    </span>
                  )}
                  {t.blocks.length > 0 && (
                    <span title={t.blocks.map((d) => `#${d.number} ${d.title}`).join("\n")}>
                      unblocks {t.blocks.map((d) => `#${d.number}`).join(", ")}
                    </span>
                  )}
                  <GitHubLink href={t.htmlUrl} />
                </div>
                <NextStepLine step={t.nextStep} />
                {(t.startStatus !== "none" || t.nextStep.startRole) && (
                  <div className="dep-actions">
                    <StartRoleButton issueId={t.id} step={t.nextStep} />
                    <TaskStartGate
                      epicId={data.epic.id}
                      taskId={t.id}
                      number={t.number}
                      startGate={data.startGate}
                      status={t.startStatus}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}
      <SystemTestCases data={data} cases={cases} />
    </div>
  );
}

/**
 * The epic's system test cases (FACTORY.md §4b) — the work a person does
 * against the assembled change.
 *
 * Not a column on the board above: a case is a parallel track, and the only
 * control it ever offers is a verdict. Pending cases are shown too, because
 * "three cases exist and none is runnable yet" is the honest reading of an
 * epic mid-build; hiding them would make the tests look absent rather than
 * waiting.
 */
function SystemTestCases({ data, cases }: { data: EpicWorkspace; cases: EpicWorkspace["tasks"] }) {
  if (cases.length === 0) return null;
  const runnable = cases.filter((c) => c.state === "factory:manual-test");
  const passed = cases.filter((c) => c.state === "factory:test-passed" || (!c.open && c.state !== "factory:test-failed"));
  const failed = cases.filter((c) => c.state === "factory:test-failed");
  const pending = cases.filter(
    (c) => c.open && c.state !== "factory:manual-test" && c.state !== "factory:test-failed" && c.state !== "factory:test-passed",
  );
  return (
    <div className="system-tests">
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
                      c.state === "factory:test-failed" ? "blocked" : c.state === "factory:manual-test" ? "task-start" : "state"
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
function TestVerdict({ caseId, label }: { caseId: string; label: string }) {
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

export function ThreadsTab({ data }: { data: EpicWorkspace }) {
  const [openThread, setOpenThread] = useState<string | null>(null);
  const nonEmpty = data.threads.filter((t) => Number(t.entryCount) > 0 || t.topicKind === "free");
  const empty = data.threads.filter((t) => Number(t.entryCount) === 0 && t.topicKind !== "free");
  /**
   * A task thread's topicRef is `task/<number>`. When that task is waiting at
   * the start gate the thread gets the same Approve button as the Tree and
   * the Tasks list — the agent's "an implementer can start" note is exactly
   * where a reader asks what to do next, and Resolve is not that answer.
   */
  const startGateTaskFor = (topicRef: string) => {
    const m = /^task\/(\d+)$/.exec(topicRef);
    if (!m) return null;
    const task = data.tasks.find((t) => t.number === Number(m[1]));
    return task && task.startStatus !== "none" ? task : null;
  };
  return (
    <div>
      {nonEmpty.map((t) => (
        <ThreadCard
          key={t.id}
          threadId={t.id}
          summary={t}
          epicId={data.epic.id}
          startGateTask={startGateTaskFor(t.topicRef)}
          startGate={data.startGate}
          expanded={openThread === t.id}
          onToggle={() => setOpenThread(openThread === t.id ? null : t.id)}
        />
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
  epicId,
  startGateTask,
  startGate,
  expanded,
  onToggle,
}: {
  threadId: string;
  summary: { title: string; status: string; entryCount: number; topicRef: string };
  epicId: string;
  startGateTask: { id: string; number: number; startStatus: TaskStartStatus } | null;
  startGate: EpicWorkspace["startGate"];
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
          {summary.title} <span className="muted">({summary.entryCount})</span>{" "}
          {startGateTask && (
            <span className={`badge ${startGateTask.startStatus === "running" ? "state" : "task-start"}`}>
              {START_STATUS_LABEL[startGateTask.startStatus]}
            </span>
          )}
        </h3>
        <span className="row" onClick={(e) => e.stopPropagation()}>
          {/* Collapsed, the button rides the header; expanded, it sits in the
              composer row beside Resolve. One Approve on screen either way. */}
          {!expanded && startGateTask && startStatusTakesApproval(startGateTask.startStatus) && (
            <TaskStartGate
              epicId={epicId}
              taskId={startGateTask.id}
              number={startGateTask.number}
              startGate={startGate}
              status={startGateTask.startStatus}
            />
          )}
          <span className="muted" style={{ cursor: "pointer" }} onClick={onToggle}>
            {expanded ? "▾" : "▸"}
          </span>
        </span>
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
                {e.htmlUrl && <GitHubLink href={e.htmlUrl} />}
              </div>
              <div className="markdown-body" dangerouslySetInnerHTML={{ __html: e.bodyHtml }} />
            </div>
          ))}
          <div className="thread-composer" style={{ marginTop: "0.6rem" }}>
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
              {startGateTask && (
                <TaskStartGate
                  epicId={epicId}
                  taskId={startGateTask.id}
                  number={startGateTask.number}
                  startGate={startGate}
                  status={startGateTask.startStatus}
                />
              )}
              <button
                onClick={() => setStatus.mutate(summary.status === "open" ? "resolved" : "open")}
                title="Closes this conversation in the Console — it does not approve anything"
              >
                {summary.status === "open" ? "Resolve thread" : "Reopen thread"}
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
            {e.link && <GitHubLink href={e.link} />}
          </span>
        </div>
      ))}
      {timeline.data?.events.length === 0 && <p className="muted">No events yet.</p>}
    </div>
  );
}
