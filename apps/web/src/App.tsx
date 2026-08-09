import { useQuery } from "@tanstack/react-query";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, ApiError } from "./api.js";
import type { Me, SetupStatus } from "./types.js";
import { MissionControl } from "./pages/MissionControl.js";
import { EpicWorkspacePage } from "./pages/EpicWorkspace.js";
import { BlockedPage } from "./pages/Blocked.js";
import { DecisionsPage } from "./pages/Decisions.js";
import { OnboardingPage } from "./pages/Onboarding.js";
import { SetupPage } from "./pages/Setup.js";

export function App() {
  const location = useLocation();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api.get<SetupStatus>("/api/setup/status"), retry: false });
  const me = useQuery<Me, ApiError>({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me"), retry: false });

  if (location.pathname === "/setup") return <SetupPage />;
  if (setup.data && !setup.data.configured && !setup.data.devLogin) return <SetupPage />;

  if (me.isLoading || (!me.data && !me.isError)) return <div className="main">Loading…</div>;
  if (me.isError || !me.data) {
    if (me.error.status === 401) return <LoginPage devLogin={setup.data?.devLogin ?? false} />;
    return (
      <div className="login-page">
        <div className="login-card">
          <h2>Factory Console</h2>
          <p className="banner error">{me.error.message}</p>
          {me.error.status === 403 && (
            <p className="muted">
              Signed in, but no org membership yet. Install the GitHub App on your org, then sign in again — or sign in with an
              account that can read an estate repo.
            </p>
          )}
          <p>
            <a href="/auth/github/login">
              <button className="primary">Sign in again</button>
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <NavLink to="/" className="brand">
          ⚙ Factory Console
        </NavLink>
        <nav>
          <NavLink to="/" end>
            Mission control
          </NavLink>
          <NavLink to="/blocked">Blocked</NavLink>
          <NavLink to="/decisions">Decisions</NavLink>
          <NavLink to="/onboarding">Onboarding</NavLink>
        </nav>
        <div style={{ marginTop: "2rem" }} className="muted">
          {me.data.avatarUrl && (
            <img src={me.data.avatarUrl} alt="" width={22} height={22} style={{ borderRadius: "50%", verticalAlign: "middle", marginRight: 6 }} />
          )}
          @{me.data.login}
          <div style={{ marginTop: "0.5rem" }}>
            <button
              onClick={() => {
                void api.post("/api/auth/logout").then(() => window.location.reload());
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<MissionControl />} />
          <Route path="/epics/:id" element={<EpicWorkspacePage me={me.data} />} />
          <Route path="/blocked" element={<BlockedPage />} />
          <Route path="/decisions" element={<DecisionsPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/setup" element={<SetupPage />} />
        </Routes>
      </main>
    </div>
  );
}

function LoginPage({ devLogin }: { devLogin: boolean }) {
  return (
    <div className="login-page">
      <div className="login-card">
        <h2>⚙ Factory Console</h2>
        <p className="muted">
          A lens and a control panel over your software factory. GitHub stays the state machine; every action here is a GitHub
          operation under your own identity.
        </p>
        <a href="/auth/github/login">
          <button className="primary">Sign in with GitHub</button>
        </a>
        {devLogin && (
          <p className="muted" style={{ marginTop: "1rem" }}>
            Dev mode: <a href="/auth/dev-login">sign in without GitHub</a>
          </p>
        )}
      </div>
    </div>
  );
}
