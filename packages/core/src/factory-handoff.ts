/**
 * Why an issue is (or is not) running under the Software Factory orchestrator.
 *
 * Nothing in the Console starts a factory role. GitHub delivers the App's
 * webhooks to PUBLIC_ORIGIN, the Console records them, and the worker forwards
 * the routable ones to the orchestrator's POST /events; the orchestrator then
 * routes the event and runs a role. Every one of those hops can decline
 * silently — the org can be on Actions, ORCHESTRATOR_URL can be unset, the
 * repo can have never claimed the engine, a run can die without clearing its
 * `factory:in-progress` marker — and the issue simply sits there.
 *
 * This module turns the facts the Console already holds (labels + what the
 * orchestrator says about runs on the issue) into one named state with a
 * sentence a human can act on, so the board never just says "not started yet".
 * It is pure: the API supplies the facts, the web app renders the answer.
 */

import { normalizeConsoleOrchestrator, type ConsoleOrchestrator } from "./orchestrator.js";

export const IN_PROGRESS_LABEL = "factory:in-progress";

/**
 * A role run is capped at 45 minutes on the orchestrator (ROLE_TIMEOUT_SECONDS).
 * A marker still standing past this is not a slow run, it is a lost one.
 */
export const DEFAULT_STALL_MINUTES = 50;

/**
 * The role the orchestrator's router picks for an issue in this state, mirroring
 * `router.py`'s label table. The Console shows this so "Start factory run" can
 * say what it is about to run instead of "factory".
 */
const START_ROLES: ReadonlyArray<{ label: string; role: string; human: string }> = [
  { label: "factory:fast-track", role: "fasttrack", human: "fast lane" },
  { label: "factory:profile", role: "profiler", human: "Profiler" },
  { label: "factory:spec-approved", role: "planner", human: "Planner" },
  { label: "factory:design-approved", role: "dispatch", human: "Dispatcher" },
  { label: "factory:release-approved", role: "release", human: "release fan-out" },
  { label: "factory:intake", role: "intake", human: "Intake" },
];

export type StartRole = { label: string; role: string; human: string };

/** Which role a Start would run, and the label that decides it. */
export function factoryStartRole(labels: readonly string[]): StartRole | null {
  return START_ROLES.find((r) => labels.includes(r.label)) ?? null;
}

export type HandoffStatus =
  | "actions"
  | "idle"
  | "not-configured"
  | "waiting"
  | "failed"
  | "running"
  | "stalled"
  | "orphaned"
  | "unknown";

/** One run as the orchestrator's GET /runs reports it, normalized to camelCase. */
export interface HandoffRun {
  id: string;
  role: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: string | null;
  error: string | null;
}

export interface HandoffInput {
  /** The org's engine choice (orgs.orchestrator). */
  engine: string | null | undefined;
  open: boolean;
  labels: readonly string[];
  /** ORCHESTRATOR_URL and ORCHESTRATOR_DISPATCH_TOKEN are both set. */
  configured: boolean;
  /** Why not, when `configured` is false. */
  configuredDetail?: string | null;
  /** Runs the orchestrator reports for this issue; null when it could not be asked. */
  runs: readonly HandoffRun[] | null;
  runsError?: string | null;
  now?: number;
  stallMinutes?: number;
}

export interface FactoryHandoff {
  engine: ConsoleOrchestrator;
  githubActionsEnabled: boolean;
  status: HandoffStatus;
  /** One line naming the state. */
  headline: string;
  /** Why it is in that state — the hop that did or did not happen. */
  detail: string;
  /** What the human should do, or null when there is nothing to do. */
  nextStep: string | null;
  canStart: boolean;
  canClearMarker: boolean;
  startsRole: StartRole | null;
  run: (HandoffRun & { minutesRunning: number }) | null;
  runsError: string | null;
}

function minutesSince(iso: string | null, now: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.round((now - t) / 60_000));
}

function humanDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const HANDOFF_CHAIN =
  "GitHub delivers this repo's webhooks to the Console, the Console forwards the routable ones to the " +
  "orchestrator, and the orchestrator decides which role to run. Nothing here starts a role by itself.";

export function factoryHandoff(input: HandoffInput): FactoryHandoff {
  const engine = normalizeConsoleOrchestrator(input.engine);
  const githubActionsEnabled = engine === "github-actions";
  const now = input.now ?? Date.now();
  const stallMinutes = input.stallMinutes ?? DEFAULT_STALL_MINUTES;
  const labels = input.labels;
  const inProgress = labels.includes(IN_PROGRESS_LABEL);
  const startsRole = factoryStartRole(labels);
  const runsError = input.runsError ?? null;

  const base = {
    engine,
    githubActionsEnabled,
    startsRole,
    canStart: false,
    canClearMarker: false,
    run: null,
    runsError,
  } as const;

  if (githubActionsEnabled) {
    return {
      ...base,
      status: "actions",
      headline: "This org runs factory roles on GitHub Actions.",
      detail:
        "The Software Factory orchestrator is not involved. Roles start from the labelled issue as workflow runs, " +
        "and this page links them rather than starting them.",
      nextStep: null,
    };
  }

  if (!input.open) {
    return {
      ...base,
      status: "idle",
      headline: "This issue is closed.",
      detail: "The orchestrator does not run roles on closed issues.",
      nextStep: null,
    };
  }

  if (!startsRole && !inProgress) {
    return {
      ...base,
      status: "idle",
      headline: "No factory role is waiting on this issue.",
      detail:
        "None of the labels that start a role are on it, so the orchestrator has nothing to route. " +
        "Apply `factory:intake` to run it through the full pipeline, or `factory:fast-track` for the fast lane.",
      nextStep: null,
    };
  }

  if (!input.configured) {
    return {
      ...base,
      status: "not-configured",
      headline: "The Console cannot reach the Software Factory orchestrator.",
      detail:
        (input.configuredDetail ??
          "ORCHESTRATOR_URL and ORCHESTRATOR_DISPATCH_TOKEN are not both set on the Console.") +
        " Until they are, nothing GitHub delivers here is forwarded, and every factory issue in this org will sit " +
        "exactly where this one is.",
      nextStep: "Set ORCHESTRATOR_URL and ORCHESTRATOR_DISPATCH_TOKEN on the Console, then start the run.",
    };
  }

  const runs = input.runs;
  const live = runs?.find((r) => !r.finishedAt) ?? null;
  const last = runs?.[0] ?? null;

  if (inProgress) {
    if (!runs) {
      return {
        ...base,
        status: "unknown",
        headline: "`factory:in-progress` is on this issue, but the orchestrator did not answer.",
        detail:
          `The Console could not ask the orchestrator what is running${runsError ? ` (${runsError})` : ""}, ` +
          "so it cannot tell a live run from a marker left behind by a dead one.",
        nextStep: "Check that the orchestrator is up, then reload this page.",
      };
    }
    if (live) {
      const minutes = minutesSince(live.startedAt, now);
      const role = live.role ?? "role";
      if (minutes < stallMinutes) {
        return {
          ...base,
          status: "running",
          run: { ...live, minutesRunning: minutes },
          headline: `The ${role} has been running for ${humanDuration(minutes)}.`,
          detail:
            "The orchestrator marks an issue `factory:in-progress` while a role is live and clears the marker when " +
            "the role ends, whatever the outcome. Nothing else will pick this issue up until then.",
          nextStep: null,
        };
      }
      return {
        ...base,
        status: "stalled",
        run: { ...live, minutesRunning: minutes },
        canClearMarker: true,
        headline: `The ${role} run has been in progress for ${humanDuration(minutes)} — past the ${stallMinutes}-minute role timeout.`,
        detail:
          "A role that finishes always clears `factory:in-progress` and comments its outcome on the issue. A marker " +
          "this old means the run never reported back — usually the orchestrator was restarted mid-run. While the " +
          "marker stands the issue looks busy: relabelling it does nothing, and the fast lane refuses to take over " +
          "work the pipeline has already started.",
        nextStep: "Clear the stuck marker, then start the run again.",
      };
    }
    return {
      ...base,
      status: "orphaned",
      canClearMarker: true,
      headline: "`factory:in-progress` is on this issue, but the orchestrator has no run for it.",
      detail:
        "The marker outlived the run that applied it. Every restart path checks it first, so the issue reads as " +
        "in flight and is skipped: labelling it `factory:fast-track` will not start the fast lane, and the button " +
        "to start a run is hidden while it is set.",
      nextStep: "Clear the stuck marker, then start the run again.",
    };
  }

  const failed = last && last.finishedAt && last.outcome && !["success", "running"].includes(last.outcome);
  if (failed && last) {
    return {
      ...base,
      status: "failed",
      run: { ...last, minutesRunning: minutesSince(last.startedAt, now) },
      canStart: Boolean(startsRole),
      headline: `The last ${last.role ?? "factory"} run on this issue ended as ${
        last.outcome === "no_op" ? "no-op (it changed nothing on GitHub)" : last.outcome
      }.`,
      detail:
        (last.error ? `${last.error} ` : "") +
        "Nothing is running now. Work it completed before failing may still have landed — check this thread and any " +
        "PR it links before starting again.",
      nextStep: startsRole ? `Start the ${startsRole.human} again once the cause is fixed.` : null,
    };
  }

  return {
    ...base,
    status: "waiting",
    canStart: Boolean(startsRole),
    headline: `Nothing has run on this issue — the ${startsRole?.human ?? "factory"} has not been started.`,
    detail:
      `${HANDOFF_CHAIN} The orchestrator reports no run for this issue, so either the label event was never ` +
      "forwarded to it, or it dropped the event — most often because the repo's " +
      "`.github/factory-orchestrator.json` does not claim this engine on its default branch." +
      (startsRole ? ` \`${startsRole.label}\` is the label that decides the role.` : ""),
    nextStep: startsRole ? `Start factory run — this runs the ${startsRole.human}.` : null,
  };
}
