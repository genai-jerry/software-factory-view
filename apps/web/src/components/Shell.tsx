import { createContext, useContext, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { applyTheme, cycleTheme, getThemePref, type ThemePref } from "../theme.js";
import { useFocus } from "../lib/filter.js";
import { isOrgAdminRole, canReachSettings } from "../lib/labels.js";
import type { Me, MyWork, ProjectsData, SetupStatus } from "../types.js";
import { repoColor } from "./RepoChip.js";
import { Sheet } from "./Sheet.js";
import { HaltBar } from "./HaltBar.js";
import { UsageBadge } from "./UsageBadge.js";

export interface HaltState {
  title: string;
  detail?: string | null;
  actionLabel: string;
  onAction: () => void;
}

const HaltCtx = createContext<{ halt: HaltState | null; setHalt: (h: HaltState | null) => void } | null>(null);

export function useHalt() {
  const ctx = useContext(HaltCtx);
  if (!ctx) throw new Error("useHalt outside Shell");
  return ctx;
}

export { canReachSettings } from "../lib/labels.js";

export function Shell({
  me,
  setup,
  children,
}: {
  me: Me;
  setup: SetupStatus | undefined;
  children: ReactNode;
}) {
  const [halt, setHalt] = useState<HaltState | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [themePref, setThemePref] = useState<ThemePref>(getThemePref());
  const location = useLocation();
  const showSettings = canReachSettings(me, setup);
  const focus = useFocus();
  // The Decisions badge counts work items, not issues: sixteen test cases on
  // one epic are one decision for the tester.
  const myWork = useQuery({ queryKey: ["my-work", focus.key], queryFn: () => api.get<MyWork>(`/api/my-work${focus.qs}`) });
  const inboxCount = new Set((myWork.data?.needsYou ?? []).map((e) => e.epicId)).size;

  return (
    <HaltCtx.Provider value={{ halt, setHalt }}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="shell">
        <header className="topbar" role="banner">
          <NavLink to="/" className="brand" end>
            Compass
          </NavLink>
          <FocusControls />
          <span className="topbar-who">
            <UsageBadge />
            {me.avatarUrl && <img src={me.avatarUrl} alt="" width={28} height={28} />}
            <span className="muted">@{me.login}</span>
          </span>
        </header>

        {halt && location.pathname === "/" && (
          <HaltBar title={halt.title} detail={halt.detail} actionLabel={halt.actionLabel} onAction={halt.onAction} />
        )}

        <div className="shell-body">
          <nav className="sidenav" aria-label="Primary">
            <PrimaryLinks inboxCount={inboxCount} />
            <div className="sidenav-foot">
              {showSettings && (
                <NavLink to="/settings">{setup?.canEditApp && !me.orgs.some((o) => isOrgAdminRole(o.role)) ? "GitHub App" : "Settings"}</NavLink>
              )}
              <button
                type="button"
                className="theme-toggle"
                onClick={() => {
                  const next = cycleTheme(themePref);
                  applyTheme(next);
                  setThemePref(next);
                }}
                aria-label={`Colour theme, currently ${themePref}`}
              >
                Theme: {themePref}
              </button>
              <button
                type="button"
                onClick={() => {
                  void api.post("/api/auth/logout").then(() => window.location.reload());
                }}
              >
                Sign out
              </button>
            </div>
          </nav>
          <main id="main" className="main" tabIndex={-1}>
            {children}
          </main>
        </div>

        <nav className="bottom-nav" aria-label="Primary">
          <PrimaryLinks inboxCount={inboxCount} onMore={() => setMoreOpen(true)} />
        </nav>
      </div>

      {moreOpen && (
        <Sheet title="More" onClose={() => setMoreOpen(false)}>
          <MoreMenu
            me={me}
            setup={setup}
            showSettings={showSettings}
            themePref={themePref}
            onTheme={() => {
              const next = cycleTheme(themePref);
              applyTheme(next);
              setThemePref(next);
            }}
            onNavigate={() => setMoreOpen(false)}
          />
        </Sheet>
      )}
    </HaltCtx.Provider>
  );
}

function PrimaryLinks({ inboxCount, onMore }: { inboxCount: number; onMore?: () => void }) {
  return (
    <>
      <NavLink to="/" end>
        Work
      </NavLink>
      <NavLink to="/decisions">
        Decisions
        {inboxCount > 0 && (
          <span className="nav-badge" aria-label={`${inboxCount} waiting on you`}>
            {inboxCount}
          </span>
        )}
      </NavLink>
      {onMore ? (
        <button type="button" className="nav-more" onClick={onMore}>
          More
        </button>
      ) : (
        <MoreInline />
      )}
    </>
  );
}

/** The screens the redesign hides from the team but engineers still reach. */
function EngineerLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <NavLink to="/pipeline" onClick={onNavigate}>
        Pipeline
      </NavLink>
      <NavLink to="/flow" onClick={onNavigate}>
        Flow
      </NavLink>
      <NavLink to="/blocked" onClick={onNavigate}>
        Inbox
      </NavLink>
      <NavLink to="/decision-log" onClick={onNavigate}>
        Decision log
      </NavLink>
      <NavLink to="/onboarding" onClick={onNavigate}>
        Onboarding
      </NavLink>
    </>
  );
}

function MoreInline() {
  return (
    <div className="sidenav-group">
      <span className="sidenav-group-title">For engineers</span>
      <EngineerLinks />
    </div>
  );
}

function MoreMenu({
  me,
  setup,
  showSettings,
  themePref,
  onTheme,
  onNavigate,
}: {
  me: Me;
  setup: SetupStatus | undefined;
  showSettings: boolean;
  themePref: ThemePref;
  onTheme: () => void;
  onNavigate: () => void;
}) {
  const themeLabel = themePref === "system" ? "System" : themePref === "light" ? "Light" : "Dark";
  return (
    <div className="more-menu">
      <EngineerLinks onNavigate={onNavigate} />
      {showSettings && setup?.canEditApp && (
        <NavLink to="/settings" onClick={onNavigate}>
          GitHub App
        </NavLink>
      )}
      {showSettings && me.orgs.some((o) => isOrgAdminRole(o.role)) && (
        <NavLink to="/settings" onClick={onNavigate}>
          Organisation
        </NavLink>
      )}
      <button type="button" onClick={onTheme} aria-label={`Colour theme, currently ${themeLabel}`}>
        Theme: {themeLabel}
      </button>
      <button
        type="button"
        onClick={() => {
          void api.post("/api/auth/logout").then(() => window.location.reload());
        }}
      >
        Sign out
      </button>
    </div>
  );
}

function FocusControls() {
  const focus = useFocus();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectsData>("/api/projects") });
  if (!projects.data) return null;
  const { projects: projectList, unassigned } = projects.data;
  const repoOptions = focus.project
    ? (projectList.find((p) => p.id === focus.project)?.repos ?? [])
    : [...projectList.flatMap((p) => p.repos), ...unassigned];
  const activeRepo = repoOptions.find((r) => r.id === focus.repo);
  const activeProject = projectList.find((p) => p.id === focus.project);

  return (
    <div className="focus-controls">
      <label className="sr-only" htmlFor="focus-project">
        Focus project
      </label>
      {projectList.length > 0 && (
        <select id="focus-project" value={focus.project} onChange={(e) => focus.setProject(e.target.value)}>
          <option value="">All projects</option>
          {projectList.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <label className="sr-only" htmlFor="focus-repo">
        Focus repository
      </label>
      <select id="focus-repo" value={focus.repo} onChange={(e) => focus.setRepo(e.target.value)}>
        <option value="">{focus.project ? "All repos in project" : "All repos"}</option>
        {repoOptions.map((r) => (
          <option value={r.id} key={r.id}>
            {r.fullName}
          </option>
        ))}
      </select>
      {(activeRepo || activeProject) && (
        <span className="badge focus-active">
          {activeRepo && <span className="repo-dot" style={{ background: repoColor(activeRepo.fullName) }} />}
          {activeRepo ? activeRepo.fullName : `project: ${activeProject!.name}`}
          <button
            className="focus-clear"
            type="button"
            aria-label="Clear focus"
            onClick={() => {
              focus.setProject("");
              focus.setRepo("");
            }}
          >
            Clear
          </button>
        </span>
      )}
    </div>
  );
}
