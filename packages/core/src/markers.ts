/**
 * Hidden-comment markers. The factory already stamps agent comments with
 * `<!-- factory-agent -->`; the Console namespaces its own structural markers
 * under `console:*` so the two can never collide. Thread membership and
 * decision identity live in these markers inside ordinary GitHub comments,
 * which is what makes the projection rebuildable (spec 02 §1) and keeps
 * non-Console users first-class (spec 06 §3).
 */

export const FACTORY_AGENT_MARKER = "<!-- factory-agent -->";

const CONSOLE_MARKER_RE = /<!--\s*console:([a-z]+)=([A-Za-z0-9_\-./]+)\s*-->/g;

export interface ConsoleMarkers {
  thread?: string;
  decision?: string;
}

export function parseConsoleMarkers(body: string): ConsoleMarkers {
  const out: ConsoleMarkers = {};
  for (const m of body.matchAll(CONSOLE_MARKER_RE)) {
    const key = m[1];
    const value = m[2];
    if (key === "thread" && value) out.thread = value;
    if (key === "decision" && value) out.decision = value;
  }
  return out;
}

export function threadMarker(threadRef: string): string {
  assertMarkerSafe(threadRef);
  return `<!-- console:thread=${threadRef} -->`;
}

export function decisionMarker(decisionId: string): string {
  assertMarkerSafe(decisionId);
  return `<!-- console:decision=${decisionId} -->`;
}

function assertMarkerSafe(value: string): void {
  if (!/^[A-Za-z0-9_\-./]+$/.test(value)) {
    throw new Error(`marker value contains characters outside the marker alphabet: ${value}`);
  }
}

export function isAgentComment(body: string): boolean {
  return body.includes(FACTORY_AGENT_MARKER);
}

/**
 * The factory router's gate trigger is an exact-match comparison against the
 * literal string "Approved" (factory-pipeline.yml). A body that carries a
 * Console marker is therefore NOT an approval — which is exactly why the
 * Console posts approvals as the bare literal, with no marker (spec 06 §4).
 */
export function isApprovedComment(body: string): boolean {
  return body.trim() === "Approved";
}

/** Strip console markers for display contexts that should not show them. */
export function stripConsoleMarkers(body: string): string {
  return body.replace(CONSOLE_MARKER_RE, "").trimEnd();
}
