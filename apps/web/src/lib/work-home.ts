/**
 * Where new work goes by default, from the focus in the top bar. Most people
 * work inside one project all day; work they open there should land there
 * without picking it again.
 *
 * In order: the focused repo; else, in the focused project, the repo this
 * browser last filed work in for it, the coordination repo (where cross-repo
 * epics live), then its first repo; with no focus, the last repo used, then
 * the first.
 */

export interface WorkTarget {
  id: string;
  fullName: string;
  projectId: string | null;
  projectName: string | null;
  factoryEnabled: boolean;
  coordination?: boolean;
}

const KEY = "compass-last-work-repo";

function remembered(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** Remember where work was just filed, for the next time in that project. */
export function rememberWorkRepo(target: WorkTarget | undefined): void {
  if (!target) return;
  try {
    const all = remembered();
    all[target.projectId ?? ""] = target.id;
    all["*"] = target.id;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode: no memory, the other defaults still apply */
  }
}

export function defaultWorkRepo(enabled: WorkTarget[], focus: { project: string; repo: string }): string {
  if (focus.repo && enabled.some((t) => t.id === focus.repo)) return focus.repo;
  const last = remembered();
  const inProject = focus.project ? enabled.filter((t) => t.projectId === focus.project) : [];
  if (inProject.length) {
    const pick = last[focus.project];
    return (
      (pick && inProject.some((t) => t.id === pick) ? pick : "") ||
      inProject.find((t) => t.coordination)?.id ||
      inProject[0]!.id
    );
  }
  const any = last["*"];
  return (any && enabled.some((t) => t.id === any) ? any : "") || enabled[0]?.id || "";
}

/** The pick list, grouped by project, the focused project first. */
export function groupedTargets(enabled: WorkTarget[], focusProject: string): Array<[string, WorkTarget[]]> {
  const groups = new Map<string, { name: string; list: WorkTarget[] }>();
  for (const t of enabled) {
    const key = t.projectId ?? "";
    const g = groups.get(key) ?? { name: t.projectName ?? "Other", list: [] };
    g.list.push(t);
    groups.set(key, g);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === focusProject ? -1 : b === focusProject ? 1 : 0));
  return keys.map((k) => [groups.get(k)!.name, groups.get(k)!.list]);
}
