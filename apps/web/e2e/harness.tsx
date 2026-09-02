import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { useMemo } from "react";
import { MemoryRouter } from "react-router-dom";
import { FocusProvider } from "../src/lib/filter.js";
import { Shell } from "../src/components/Shell.js";
import { Sheet } from "../src/components/Sheet.js";
import { ActionBar } from "../src/components/ActionBar.js";
import { HaltBar } from "../src/components/HaltBar.js";
import { Banner } from "../src/components/Banner.js";
import { FactoryRunStatus } from "../src/components/FactoryRunStatus.js";
import { HomePage } from "../src/pages/Home.js";
import { ExpediteToggle, GateTab, TasksTab } from "../src/pages/EpicWorkspace.js";
import { EXPEDITE_BADGE, EXPEDITE_TITLE } from "../src/lib/labels.js";
import type { EpicWorkspace, GatePanelData, Me, SetupStatus } from "../src/types.js";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import "../src/styles.css";

const params = new URLSearchParams(window.location.search);
const screen = params.get("screen") ?? "shell";

const me: Me = {
  login: "tester",
  name: "Test User",
  avatarUrl: null,
  orgs: [{ id: "org-1", name: "acme", role: "member" }],
};

const setup: SetupStatus = {
  configured: true,
  source: "database",
  appSlug: "factory",
  appId: "1",
  clientId: "client",
  hasWebhookSecret: true,
  canEditApp: false,
  hasMasterKey: true,
  credentialError: null,
  publicOrigin: "http://localhost:4177",
  insightEnabled: false,
  devLogin: false,
  appReset: false,
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } },
});

function OverflowProbe() {
  return (
    <p data-testid="overflow-probe">
      If this page pans horizontally, the compact shell failed.
    </p>
  );
}

function ShellScreen() {
  return (
    <Shell me={me} setup={setup}>
      <h1>My work</h1>
      <HaltBar title="Approve the spec" detail="G1 is waiting on you." actionLabel="Open" onAction={() => undefined} />
      <button type="button" className="link work-row-title">
        Specify the intake flow
      </button>
      <OverflowProbe />
    </Shell>
  );
}

function PeekScreen() {
  return (
    <Shell me={me} setup={setup}>
      <h1>Needs you</h1>
      <button type="button" className="link work-row-title" id="open-peek">
        Agent asked a question
      </button>
      <Sheet title="#12 Agent asked a question" onClose={() => undefined}>
        <p>The agent asked: “Which auth provider should we use?”</p>
        <textarea placeholder="Reply to unblock — posts as you on GitHub" defaultValue="" />
        <ActionBar>
          <button className="primary" type="button">
            Reply & resume
          </button>
        </ActionBar>
      </Sheet>
      <OverflowProbe />
    </Shell>
  );
}

function GateScreen({ approver }: { approver: boolean }) {
  return (
    <div className="main">
      <h1>Epic #4 · Intake flow</h1>
      <div className="tablist" role="tablist" aria-label="Epic workspace">
        <button type="button" role="tab" aria-selected={false}>
          Overview
        </button>
        <button type="button" role="tab" aria-selected={true}>
          Gate (Approve spec)
        </button>
      </div>
      <div className="card">
        <h2>Spec</h2>
        <div className="markdown-body">
          <p>The factory should file issues, then wait for a human at G1.</p>
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Gate</td>
                <td>G1 spec-ready</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      {approver ? (
        <ActionBar>
          <button className="approve" type="button">
            Approve as @tester
          </button>
        </ActionBar>
      ) : (
        <p className="muted">You are not on this gate&apos;s approver list — the actions below are hidden for you.</p>
      )}
      <OverflowProbe />
    </div>
  );
}

function HomeScreen() {
  return <HomePage me={null} setup={setup} onConnected={() => undefined} />;
}

function OnboardingScreen() {
  return (
    <div className="main">
      <h1>Onboarding</h1>
      <div className="card">
        <h3>acme/factory</h3>
        <div className="onboarding-steps">
          <details className="onboarding-step" data-step="labels" open>
            <summary>
              <span>1 · Labels</span>
              <span className="muted">now</span>
            </summary>
            <div className="onboarding-step-body">
              <div className="check-row">
                <span>Create the 14 factory labels.</span>
                <button type="button">Run</button>
              </div>
            </div>
          </details>
          <details className="onboarding-step" data-step="secrets">
            <summary>
              <span>2 · Secret</span>
              <span className="muted">later</span>
            </summary>
            <div className="onboarding-step-body">
              <p>Write the orchestrator secret.</p>
            </div>
          </details>
          <details className="onboarding-step" data-step="stubs">
            <summary>
              <span>3 · Stub files PR</span>
              <span className="muted">later</span>
            </summary>
            <div className="onboarding-step-body">
              <p>Open the enablement PR.</p>
            </div>
          </details>
          <details className="onboarding-step" data-step="validate">
            <summary>
              <span>4 · Validation suite</span>
              <span className="muted">later</span>
            </summary>
            <div className="onboarding-step-body">
              <p>Read-only checks.</p>
            </div>
          </details>
          <div className="onboarding-reset">
            <button type="button" className="danger">
              Reset factory…
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EpicRunStatusScreen() {
  const demoClient = useMemo(() => {
    const run = {
      id: "demo-run-id",
      role: "intake",
      model: "claude-sonnet-4",
      outcome: "running",
      guards: { phase: "reading the repo" },
    };
    return new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity,
          queryFn: async ({ queryKey }) => {
            if (queryKey[0] === "orchestrator-run") return run;
            throw new Error(`unexpected query ${String(queryKey[0])}`);
          },
        },
      },
    });
  }, []);
  const data: EpicWorkspace = {
    epic: {
      id: "epic-1",
      number: 4,
      title: "Intake flow",
      bodyHtml: "",
      state: "factory:intake",
      open: true,
      author: "alice",
      htmlUrl: "https://github.com/acme/api/issues/4",
      labels: ["factory:in-progress", "factory:intake"],
      status: null,
      nextStep: {
        who: "the factory",
        how: "The Intake Analyst is drafting the spec. Nothing to do.",
        startRole: null,
        startLabel: null,
        waitsOnPerson: false,
        automatic: false,
      },
    },
    repo: { id: "repo-1", fullName: "acme/api", defaultBranch: "main" },
    pipeline: ["factory:intake", "factory:spec-ready"],
    gate: null,
    expedite: { on: false, available: true, dormant: false, reason: null, lastFlip: null },
    startGate: { approvers: [], amApprover: true },
    tasks: [],
    rollup: { total: 0, ready: 0, inReview: 0, inTest: 0, shipping: 0, done: 0, blocked: 0, waiting: 0, inFlight: 0 },
    blockedSubIssues: [],
    change: null,
    artifacts: [],
    threads: [],
    freshness: { lastSyncedAt: null, stale: false },
    orchestrator: { engine: "software-factory", githubActionsEnabled: false, canStart: false },
  };
  return (
    <QueryClientProvider client={demoClient}>
      <Shell me={me} setup={setup}>
        <h1 style={{ marginBottom: 0 }}>Epic #4 · Intake flow</h1>
        <FactoryRunStatus data={data} />
        <p className="muted">Overview tab content would follow.</p>
        <OverflowProbe />
      </Shell>
    </QueryClientProvider>
  );
}

/* ---------------------------------------------------------------- expedite */

/**
 * The expedite walkthrough's fixtures. An epic mid-build with the marker on:
 * its ready task is started by the factory (`auto`), its in-review task shows
 * the automatic next hop, and neither offers an approval — which is the whole
 * claim these screens exist to check at 360px.
 */
const expediteState: EpicWorkspace["expedite"] = {
  on: true,
  available: true,
  dormant: false,
  reason: null,
  lastFlip: { on: true, actor: "tester", at: "2026-08-30T09:00:00.000Z" },
};

const expeditedWorkspace: EpicWorkspace = {
  epic: {
    id: "epic-9",
    number: 9,
    title: "Payment reminders",
    bodyHtml: "",
    state: "factory:design-approved",
    open: true,
    author: "alice",
    htmlUrl: "https://github.com/acme/api/issues/9",
    labels: ["factory:design-approved", "factory:expedite"],
    status: "Building 1/3",
    nextStep: {
      who: "its tasks",
      how: "Building — 1 of 3 tasks done.",
      startRole: null,
      startLabel: null,
      waitsOnPerson: false,
      automatic: false,
    },
  },
  repo: { id: "repo-1", fullName: "acme/api", defaultBranch: "main" },
  pipeline: [],
  gate: null,
  expedite: expediteState,
  startGate: { approvers: ["tester"], amApprover: true },
  tasks: [
    {
      id: "task-10",
      number: 10,
      title: "task(api): reminder schedule",
      state: "factory:ready",
      open: true,
      htmlUrl: "https://github.com/acme/api/issues/10",
      blockedBy: [],
      blocks: [],
      startStatus: "auto",
      approvable: false,
      nextStep: {
        who: "the factory — expedited",
        how: "Expedite is on: the factory starts the Implementer on this task itself. Nothing to approve.",
        startRole: null,
        startLabel: null,
        waitsOnPerson: false,
        automatic: true,
      },
    },
    {
      id: "task-11",
      number: 11,
      title: "task(api): reminder email",
      state: "factory:in-test",
      open: true,
      htmlUrl: "https://github.com/acme/api/issues/11",
      blockedBy: [],
      blocks: [],
      startStatus: "none",
      approvable: false,
      nextStep: {
        who: "the factory — expedited",
        how: "Expedite is on: QA runs on this task by itself.",
        startRole: "qa",
        startLabel: "Start QA",
        waitsOnPerson: false,
        automatic: true,
      },
    },
  ],
  rollup: { total: 3, ready: 1, inReview: 0, inTest: 1, shipping: 0, done: 1, blocked: 0, waiting: 0, inFlight: 1 },
  blockedSubIssues: [],
  change: null,
  artifacts: [],
  threads: [],
  freshness: { lastSyncedAt: null, stale: false },
  orchestrator: { engine: "software-factory", githubActionsEnabled: false, canStart: false },
};

const gsPanel: GatePanelData = {
  gate: "staging",
  label: "GS",
  state: "factory:epic-ready",
  amApprover: true,
  approvers: ["tester"],
  approversFrom: "release",
  commentApprovable: true,
  assembly: {
    tasks: [
      { number: 10, title: "task(api): reminder schedule", state: "factory:on-epic", open: true, htmlUrl: "https://gh/10" },
      { number: 11, title: "task(api): reminder email", state: "factory:on-epic", open: true, htmlUrl: "https://gh/11" },
    ],
    allGreen: true,
    report: {
      author: "factory-bot",
      at: "2026-08-31T10:00:00.000Z",
      html: "<p>Assembly green: 3/3 tasks on <code>factory/epic-9</code>, suite passed.</p>",
      htmlUrl: "https://gh/9#c9",
    },
    prs: [],
  },
  documentPrs: [],
  releasePrs: [],
  artifacts: [],
  currentSha: null,
  changedSinceLastView: false,
  lastViewedSha: null,
  openQuestions: [],
};

const g3Panel: GatePanelData = {
  ...gsPanel,
  gate: "release",
  label: "G3",
  state: "factory:in-staging",
  approversFrom: null,
  commentApprovable: false,
  assembly: null,
  releasePrs: [
    {
      id: "pr-1",
      number: 41,
      title: "Promote staging to main",
      kind: "promotion",
      state: "open",
      draft: false,
      ciStatus: "success",
      headRef: "staging",
      baseRef: "main",
      htmlUrl: "https://gh/pr/41",
    },
  ],
};

/** A client that answers the gate query from a fixture instead of the API. */
function gateClient(panel: GatePanelData) {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        queryFn: async ({ queryKey }) => {
          if (queryKey[0] === "gate") return panel;
          throw new Error(`unexpected query ${String(queryKey[0])}`);
        },
      },
    },
  });
}

/**
 * The toggle and the task board of an expedited epic — the two places the
 * marker changes what a reader is being asked for.
 */
function ExpediteWorkspaceScreen() {
  return (
    <Shell me={me} setup={setup}>
      <div className="spread">
        <h1 style={{ marginBottom: 0 }}>Epic #9 · Payment reminders</h1>
        <span className="row" style={{ alignItems: "center", gap: "0.4rem" }}>
          <span className="badge expedite" title={EXPEDITE_TITLE}>
            {EXPEDITE_BADGE}
          </span>
          <span className="badge state">Building 1/3</span>
        </span>
      </div>
      <ExpediteToggle epicId="epic-9" expedite={expediteState} />
      <TasksTab data={expeditedWorkspace} />
      <OverflowProbe />
    </Shell>
  );
}

/** The same epic before the marker: the confirm step is what applies it. */
function ExpediteConfirmScreen() {
  return (
    <Shell me={me} setup={setup}>
      <h1 style={{ marginBottom: 0 }}>Epic #9 · Payment reminders</h1>
      <ExpediteToggle
        epicId="epic-9"
        expedite={{ on: false, available: true, dormant: false, reason: null, lastFlip: null }}
      />
      <OverflowProbe />
    </Shell>
  );
}

function GatePanelScreen({ panel }: { panel: GatePanelData }) {
  return (
    <QueryClientProvider client={gateClient(panel)}>
      <Shell me={me} setup={setup}>
        <h1 style={{ marginBottom: 0 }}>Epic #9 · Payment reminders</h1>
        <GateTab epicId="epic-9" me={me} />
        <OverflowProbe />
      </Shell>
    </QueryClientProvider>
  );
}

function ApiDownScreen() {
  return (
    <div className="home">
      <header className="home-bar">
        <span className="home-mark">Factory Console</span>
      </header>
      <div className="home-body">
        <Banner tone="error" technical="connect ECONNREFUSED 127.0.0.1:8787">
          The Console is unavailable. Retry in a moment, or ask whoever runs this host to bring the API up.
        </Banner>
      </div>
    </div>
  );
}

function Screen() {
  switch (screen) {
    case "peek":
      return <PeekScreen />;
    case "gate":
      return <GateScreen approver />;
    case "gate-non-approver":
      return <GateScreen approver={false} />;
    case "home":
      return <HomeScreen />;
    case "onboarding":
      return <OnboardingScreen />;
    case "epic-run-status":
      return <EpicRunStatusScreen />;
    case "expedite":
      return <ExpediteWorkspaceScreen />;
    case "expedite-confirm":
      return <ExpediteConfirmScreen />;
    case "gate-staging":
      return <GatePanelScreen panel={gsPanel} />;
    case "gate-g3":
      return <GatePanelScreen panel={g3Panel} />;
    case "api-down":
      return <ApiDownScreen />;
    default:
      return <ShellScreen />;
  }
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <MemoryRouter>
      <FocusProvider>
        <Screen />
      </FocusProvider>
    </MemoryRouter>
  </QueryClientProvider>,
);
