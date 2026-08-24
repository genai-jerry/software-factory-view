import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, ApiError } from "./api.js";
import { applyTheme, cycleTheme, getThemePref, type ThemePref } from "./theme.js";
import type { Me, SetupStatus } from "./types.js";
import { HomePage } from "./pages/Home.js";
import { MissionControl } from "./pages/MissionControl.js";
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
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api.get<SetupStatus>("/api/setup/status"), retry: false });
  const me = useQuery<Me, ApiError>({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me"), retry: false });

  if (setup.isError) {
    return (
      <div className="home">
        <header className="home-bar">
          <span className="home-mark">Factory Console</span>
        </header>
        <div className="home-body">
          <div className="banner error">
            <strong>The Console API is not answering.</strong> {(setup.error as ApiError).message}
          </div>
          <p className="muted">Whoever is running this host needs to bring the API up, then reload.</p>
        </div>
      </div>
    );
  }

  // First settle only. Window-focus refetch of /api/me (a 401 until sign-in)
  // used to flip this tree back to "Loading…", remount the front door, and
  // wipe a PEM someone had just pasted after copying it from another tab.
  if (!setup.isFetched || !me.isFetched) {
    return <div className="main">Loading…</div>;
  }

  if (me.isError && me.error.status !== 401) {
    return (
      <div className="home">
        <header className="home-bar">
          <span className="home-mark">Factory Console</span>
        </header>
        <div className="home-body">
          <div className="banner error">{me.error.message}</div>
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
          <span className="home-mark">Factory Console</span>
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
    <div className="layout">
      <aside className="sidebar">
        <NavLink to="/" className="brand">
          Factory Console
        </NavLink>
        <nav>
          <NavLink to="/" end>
            Mission control
          </NavLink>
          <NavLink to="/flow">Flow</NavLink>
          <NavLink to="/blocked">Blocked</NavLink>
          <NavLink to="/decisions">Decisions</NavLink>
          <NavLink to="/onboarding">Onboarding</NavLink>
          {setup.data?.canEditApp && <NavLink to="/settings">Settings</NavLink>}
        </nav>
        <div style={{ marginTop: "2rem" }} className="muted">
          {user!.avatarUrl && (
            <img src={user!.avatarUrl} alt="" width={22} height={22} style={{ borderRadius: "50%", verticalAlign: "middle", marginRight: 6 }} />
          )}
          @{user!.login}
          <div style={{ marginTop: "0.5rem" }}>
            <button
              onClick={() => {
                void api.post("/api/auth/logout").then(() => window.location.reload());
              }}
            >
              Sign out
            </button>
          </div>
          <ThemeToggle />
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<MissionControl />} />
          <Route path="/flow" element={<FlowPage />} />
          <Route path="/epics/:id" element={<EpicWorkspacePage me={user!} />} />
          <Route path="/blocked" element={<BlockedPage />} />
          <Route path="/decisions" element={<DecisionsPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/runs/:runId" element={<OrchestratorRunPage />} />
          <Route path="/settings" element={setup.data?.canEditApp ? <SettingsPage me={user!} /> : <Navigate to="/" replace />} />
          <Route path="/setup" element={<Navigate to={setup.data?.canEditApp ? "/settings" : "/"} replace />} />
        </Routes>
      </main>
    </div>
  );
}

/** System → light → dark → system. 'System' follows the OS via prefers-color-scheme. */
function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(getThemePref());
  const icons: Record<ThemePref, string> = { system: "◐", light: "☀", dark: "☾" };
  return (
    <button
      className="theme-toggle"
      title="Cycle color theme"
      onClick={() => {
        const next = cycleTheme(pref);
        applyTheme(next);
        setPref(next);
      }}
    >
      {icons[pref]} Theme: {pref}
    </button>
  );
}
