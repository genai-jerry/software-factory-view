import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * The focus filter: one project or one repo at a time, shared by every view
 * (My work, board, Flow, Blocked) and persisted per browser so the focus
 * survives navigation and reloads. Empty string = "all".
 */
export interface RepoFocus {
  project: string;
  repo: string;
  setProject: (id: string) => void;
  setRepo: (id: string) => void;
  /** Querystring suffix for API calls, "" when unfiltered. */
  qs: string;
  /** Stable key fragment for react-query cache keys. */
  key: string;
}

const KEY = "console-focus";

const FocusContext = createContext<RepoFocus | null>(null);

export function FocusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ project: string; repo: string }>(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return JSON.parse(raw) as { project: string; repo: string };
    } catch {
      /* fresh start */
    }
    return { project: "", repo: "" };
  });
  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(state));
  }, [state]);

  const params = new URLSearchParams();
  if (state.repo) params.set("repo", state.repo);
  else if (state.project) params.set("project", state.project);
  const qs = params.size > 0 ? `?${params.toString()}` : "";

  const value: RepoFocus = {
    project: state.project,
    repo: state.repo,
    // Choosing a project clears a repo pick outside it; choosing a repo keeps the project for the dropdown cascade.
    setProject: (project) => setState((s) => ({ project, repo: project ? "" : s.repo })),
    setRepo: (repo) => setState((s) => ({ ...s, repo })),
    qs,
    key: `${state.project}|${state.repo}`,
  };
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

export function useFocus(): RepoFocus {
  const ctx = useContext(FocusContext);
  if (!ctx) throw new Error("useFocus outside FocusProvider");
  return ctx;
}
