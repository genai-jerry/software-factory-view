/** People-language labels shared by the browser and the API. See apps/web/src/lib/labels.ts. */

export const PEOPLE_LABEL: Record<string, string> = {
  "factory:intake": "Filed",
  "factory:spec-ready": "Approve spec",
  "factory:spec-approved": "Planning",
  "factory:planned": "Designing",
  "factory:design-ready": "Approve design",
  "factory:design-approved": "Released to build",
  "factory:release-planning": "Planning release",
  "factory:release-ready": "Approve release",
  "factory:release-approved": "Release approved",
  "factory:ready": "Ready to build",
  "factory:in-review": "In review",
  "factory:in-test": "In test",
  "factory:ready-to-ship": "Staging",
  "factory:on-epic": "On epic branch",
  "factory:epic-ready": "Release to staging",
  "factory:in-staging": "Merge to ship",
  "factory:deployed": "Shipped",
  "factory:blocked": "Agent halted",
  "factory:fast-track": "Fast track",
  "factory:incident": "Incident",
  "factory:backlog": "Backlog",
  "factory:profile": "Profiling",
};

export function peopleLabel(state: string | null | undefined): string {
  if (!state) return "No factory state";
  return PEOPLE_LABEL[state] ?? state.replace(/^factory:/, "");
}

/**
 * A task, test or bug title the way a person reads it: the factory's
 * `task(35): ` / `test(34): ` / `bug(35): ` prefix and any leading `#55 `
 * number removed. The user view names work by title, never by number.
 */
export function plainTitle(title: string | null | undefined): string {
  return (title ?? "")
    .replace(/^\s*#\d+\s+/, "")
    .replace(/^(?:task|test|bug)\([^)]*\):?\s*/i, "")
    .trim();
}
