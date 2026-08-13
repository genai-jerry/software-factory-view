import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { useFocus } from "../lib/filter.js";
import type { ProjectsData } from "../types.js";
import { repoColor } from "./RepoChip.js";

/**
 * The focus bar: pick a project and/or a repo and every view narrows to it.
 * The choice persists across pages and reloads; a visible chip says what the
 * current focus is so a filtered view is never mistaken for the whole world.
 */
export function FilterBar() {
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
    <div className="filter-bar">
      <span className="muted">Focus</span>
      {projectList.length > 0 && (
        <select value={focus.project} onChange={(e) => focus.setProject(e.target.value)} style={{ width: "auto" }}>
          <option value="">All projects</option>
          {projectList.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <select value={focus.repo} onChange={(e) => focus.setRepo(e.target.value)} style={{ width: "auto" }}>
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
            title="Clear focus"
            onClick={() => {
              focus.setProject("");
              focus.setRepo("");
            }}
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
