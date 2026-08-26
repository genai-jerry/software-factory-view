import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { FocusProvider } from "../src/lib/filter.js";
import { Shell } from "../src/components/Shell.js";
import { Sheet } from "../src/components/Sheet.js";
import { ActionBar } from "../src/components/ActionBar.js";
import { HaltBar } from "../src/components/HaltBar.js";
import { Banner } from "../src/components/Banner.js";
import { HomePage } from "../src/pages/Home.js";
import type { Me, SetupStatus } from "../src/types.js";
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
