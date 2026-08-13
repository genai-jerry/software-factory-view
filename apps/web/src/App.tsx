import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, ApiError } from "./api.js";
import { applyTheme, cycleTheme, getThemePref, type ThemePref } from "./theme.js";
import type { Me, SetupStatus } from "./types.js";
import { MissionControl } from "./pages/MissionControl.js";
import { EpicWorkspacePage } from "./pages/EpicWorkspace.js";
import { BlockedPage } from "./pages/Blocked.js";
import { DecisionsPage } from "./pages/Decisions.js";
import { ConnectEstate, OnboardingPage } from "./pages/Onboarding.js";
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
          <p>
            <a href="/auth/github/login">
              <button className="primary">Sign in again</button>
            </a>
          </p>
          <p className="muted">
            If that keeps failing, <a href="/setup">check the GitHub App details</a>.
          </p>
        </div>
      </div>
    );
  }

  // Membership is granted by connecting an estate you can see on GitHub, so the
  // first person to sign in to a Console necessarily belongs to nothing yet.
  // Send them to the screen that fixes it rather than to the board they cannot
  // read: signing in again would only re-run the same estate matching.
  if (me.data.orgs.length === 0) return <ConnectFirstEstate me={me.data} onConnected={() => void me.refetch()} />;

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
          <ThemeToggle />
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

/**
 * Signed in, member of nothing. Two ways to be here: a brand-new Console whose
 * first estate does not exist yet, or an account that cannot see any estate
 * this Console already has. Both are answered by the same screen — the
 * installation list is read with the user's own token, so it shows exactly
 * what they are entitled to connect, and connecting makes them its owner.
 */
function ConnectFirstEstate({ me, onConnected }: { me: Me; onConnected: () => void }) {
  return (
    <div className="main" style={{ maxWidth: "48rem" }}>
      <h1>⚙ Welcome to Factory Console</h1>
      <p className="muted">
        Signed in as <strong>@{me.login}</strong>, who does not belong to an estate here yet. Connect one below — the first
        person to connect an estate owns it — or ask someone who already has one to add you.
      </p>
      <ConnectEstate onConnected={onConnected} />
      <p className="muted">
        Nothing listed? The App is not installed on that org yet, or it is installed under an account you are not a member of.
        Install it, then hit Refresh — no need to sign in again.
      </p>
      <p className="muted">
        Wrong account?{" "}
        <button
          onClick={() => {
            void api.post("/api/auth/logout").then(() => window.location.reload());
          }}
        >
          Sign out
        </button>
      </p>
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
        {/* Sign-in runs on the Console's own GitHub App, so a wrong OAuth pair
            fails here with nothing to click. This is the way to the screen that
            fixes it. */}
        <p className="muted" style={{ marginTop: "1rem" }}>
          Sign-in failing? <a href="/setup">Check the GitHub App details</a>
        </p>
        {devLogin && (
          <p className="muted">
            Dev mode: <a href="/auth/dev-login">sign in without GitHub</a>
          </p>
        )}
      </div>
    </div>
  );
}
