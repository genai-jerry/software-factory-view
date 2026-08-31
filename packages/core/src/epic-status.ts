import { DESIGN_APPROVED_STATE } from "./factory.js";

/**
 * What an epic's badge says while its label cannot say it.
 *
 * `factory:design-approved` is the whole build (FACTORY.md §3 — "Released for
 * implementation"), and the label must stay put: it is the dispatcher's guard
 * for re-running on task close. So the epic reads "Design approved" — a gate
 * receipt, past tense — from G2 until the Release Manager takes it, with its
 * tasks visibly building underneath. The Console already knew better in two
 * places and used neither on the badge: `phaseOfState` maps this state to
 * `building`, and the task rollup ships on the same payload (Flow and Mission
 * Control have been rendering "2/4 tasks" from it all along).
 *
 * Returns null where the label is the honest answer — every other state (a
 * gate must keep reading as a call to action), and a design-approved epic the
 * Dispatcher has not fanned out yet. The caller falls back to its own label
 * vocabulary, so this adds a reading rather than replacing one.
 */
export interface EpicProgress {
  total: number;
  done: number;
  blocked: number;
  /** Merged onto the epic/integration branch, not yet closed (§6a, §6b). */
  shipping: number;
}

export function epicStatus(state: string | null | undefined, tasks: EpicProgress | undefined): string | null {
  if (state !== DESIGN_APPROVED_STATE) return null;
  if (!tasks || tasks.total === 0) return null;
  if (tasks.done === tasks.total) return `All ${tasks.total} tasks done`;
  // Everything left is on a branch waiting to ship — no longer "building".
  if (tasks.shipping > 0 && tasks.done + tasks.shipping === tasks.total) {
    return `Shipping ${tasks.done}/${tasks.total}`;
  }
  const halted = tasks.blocked > 0 ? ` · ${tasks.blocked} halted` : "";
  return `Building ${tasks.done}/${tasks.total}${halted}`;
}
