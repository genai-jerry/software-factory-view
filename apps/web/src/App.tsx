import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, ApiError, reauthenticate } from "./api.js";
import type { Me, SetupStatus } from "./types.js";
import { Banner } from "./components/Banner.js";
import { useReauthNeeded } from "./lib/reauth.js";
import { Shell, canReachSettings } from "./components/Shell.js";
import { HomePage } from "./pages/Home.js";
import { MissionControl } from "./pages/MissionControl.js";
import { WorkPage } from "./pages/Work.js";
import { DecisionsQueuePage } from "./pages/DecisionsQueue.js";
import { WorkItemPage } from "./pages/WorkItem.js";
import { NewWorkPage } from "./pages/NewWork.js";
import { ActivityPage } from "./pages/Activity.js";
import { FlowPage } from "./pages/Flow.js";
import { EpicWorkspacePage } from "./pages/EpicWorkspace.js";
import { BlockedPage } from "./pages/Blocked.js";
import { DecisionsPage } from "./pages/Decisions.js";
import { OnboardingPage } from "./pages/Onboarding.js";
import { SettingsPage } from "./pages/Settings.js";
import { OrchestratorRunPage } from "./pages/OrchestratorRun.js";

function isOrchestratorRunPath(pathname: string): boolean {
  return /^\/runs\/[^/]+$/.test(pathname);
}

export function App() {
  const location = useLocation();
  const reauthNeeded = useReauthNeeded();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api.get<SetupStatus>("/api/setup/status"), retry: false });
  const me = useQuery<Me, ApiError>({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me"), retry: false });

  if (setup.isError) {
    return (
      <div className="home">
        <header className="home-bar">
          <span className="home-mark">Compass</span>
        </header>
        <div className="home-body">
          <Banner tone="error" technical={(setup.error as ApiError).message}>
            The Console is unavailable. Retry in a moment, or ask whoever runs this host to bring the API up.
          </Banner>
        </div>
      </div>
    );
  }

  if (!setup.isFetched || !me.isFetched) {
    return <div className="main">Loading…</div>;
  }

  if (me.isError && me.error.status !== 401) {
    return (
      <div className="home">
        <header className="home-bar">
          <span className="home-mark">Compass</span>
        </header>
        <div className="home-body">
          <Banner tone="error" technical={me.error.message}>
            Sign-in did not complete. Try again.
          </Banner>
          <p>
            <a href="/auth/github/login">
              <button className="primary">Sign in again</button>
            </a>
          </p>
        </div>
      </div>
    );
  }

  const user = me.data ?? null;
  const signedIn = Boolean(user);
  const needsFrontDoor = !signedIn || user!.orgs.length === 0;
  const onRunPath = isOrchestratorRunPath(location.pathname);

  if (!signedIn && onRunPath) {
    return (
      <div className="home">
        <header className="home-bar">
          <span className="home-mark">Compass</span>
        </header>
        <div className="home-body">
          <h1>Orchestrator run</h1>
          <p className="muted">
            This URL is the live log for a Software Factory role. Sign in with GitHub to see the outcome, model, and
            transcript.
          </p>
          <p>
            <a href={`/auth/github/login?next=${encodeURIComponent(location.pathname)}`}>
              <button className="primary">Sign in with GitHub</button>
            </a>
          </p>
        </div>
      </div>
    );
  }

  if (needsFrontDoor && !onRunPath) {
    return (
      <HomePage
        me={user}
        setup={setup.data}
        onConnected={() => {
          window.location.assign("/onboarding");
        }}
      />
    );
  }

  return (
    <Shell me={user!} setup={setup.data}>
      {reauthNeeded ? (
        <Banner tone="error">
          GitHub sign-in has expired and could not be renewed — writes will fail until you sign in again.{" "}
          <button className="link" onClick={reauthenticate}>
            Sign in again
          </button>
        </Banner>
      ) : null}
      <Routes>
        <Route path="/" element={<WorkPage />} />
        <Route path="/pipeline" element={<MissionControl />} />
        <Route path="/flow" element={<FlowPage />} />
        <Route path="/epics/:id" element={<EpicWorkspacePage me={user!} />} />
        <Route path="/work/new" element={<NewWorkPage />} />
        <Route path="/work/:id" element={<WorkItemPage me={user!} />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/blocked" element={<BlockedPage />} />
        <Route path="/decisions" element={<DecisionsQueuePage />} />
        <Route path="/decision-log" element={<DecisionsPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/runs/:runId" element={<OrchestratorRunPage />} />
        <Route
          path="/settings"
          element={canReachSettings(user!, setup.data) ? <SettingsPage me={user!} /> : <Navigate to="/" replace />}
        />
        <Route path="/setup" element={<Navigate to={canReachSettings(user!, setup.data) ? "/settings" : "/"} replace />} />
      </Routes>
    </Shell>
  );
}
