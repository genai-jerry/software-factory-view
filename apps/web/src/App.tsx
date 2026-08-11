import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, ApiError } from "./api.js";
import type { Me, SetupStatus } from "./types.js";
import { MissionControl } from "./pages/MissionControl.js";
import { EpicWorkspacePage } from "./pages/EpicWorkspace.js";
import { BlockedPage } from "./pages/Blocked.js";
import { DecisionsPage } from "./pages/Decisions.js";
import { OnboardingPage } from "./pages/Onboarding.js";
import { SetupPage } from "./pages/Setup.js";
import { LogsPage } from "./pages/Logs.js";

export function App() {
  const location = useLocation();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api.get<SetupStatus>("/api/setup/status"), retry: false });
  const me = useQuery<Me, ApiError>({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me"), retry: false });

  if (location.pathname === "/setup") return <SetupPage />;
  if (setup.data && !setup.data.configured && !setup.data.devLogin) return <SetupPage />;

  if (me.isLoading || (!me.data && !me.isError)) return <div className="main">Loading…</div>;
  if (me.isError || !me.data) {
    if (me.error.status === 401) return <LoginPage devLogin={setup.data?.devLogin ?? false} />;
    // Nobody has claimed this Console yet: membership is granted by being able
    // to read a repo in a connected estate, and on a fresh install there are
    // none — so the first user would otherwise be locked out of the very page
    // that connects one. "Org" here is the Console's own tenant record, not a
    // GitHub organisation; a personal account is fine.
    if (me.error.status === 403 && setup.data?.claimable) return <ClaimConsole />;

    return (
      <div className="login-page">
        <div className="login-card">
          <h2>Factory Console</h2>
          <p className="banner error">{me.error.message}</p>
          {me.error.status === 403 && (
            <p className="muted">
              Signed in, but you are not a member of any estate on this Console. Ask an owner to connect an estate containing a
              repository you can read, then sign in again.
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
          <NavLink to="/logs">Logs</NavLink>
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
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/setup" element={<SetupPage />} />
        </Routes>
      </main>
    </div>
  );
}

/**
 * First-run claim. The Console's tenancy is its own — an "org" here is a row in
 * its database, not a GitHub organisation — so a personal GitHub account needs
 * nothing bought or created on GitHub's side. Only offered while no membership
 * exists anywhere on the instance; the API refuses a second claim.
 */
function ClaimConsole() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = () => {
    setBusy(true);
    setError(null);
    api
      .post("/api/setup/claim-owner")
      .then(() => window.location.assign("/onboarding"))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="login-page">
      <div className="login-card" style={{ maxWidth: "34rem", textAlign: "left" }}>
        <h2 style={{ textAlign: "center" }}>⚙ Claim this Console</h2>
        <p className="muted">
          Nobody owns this Console yet. Claiming it makes you the owner, which is what lets you connect an estate — the
          repositories this Console watches.
        </p>
        <p className="muted">
          This does not need a GitHub organisation. The Console keeps its own tenancy, so a personal account works; you connect
          whichever repositories the App is installed on, personal or org-owned.
        </p>
        {error && <div className="banner error">{error}</div>}
        <p style={{ textAlign: "center" }}>
          <button className="primary" onClick={claim} disabled={busy}>
            {busy ? "Claiming…" : "Claim it and continue →"}
          </button>
        </p>
      </div>
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
