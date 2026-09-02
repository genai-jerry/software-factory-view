import { useSyncExternalStore } from "react";

/**
 * Whether the API has told us the GitHub authorization is beyond renewal.
 *
 * The API refreshes the user's OAuth grant on its own, so this is rare — a
 * revoked App, a refresh token past its six months, an authorization the user
 * withdrew on GitHub. It is worth a standing banner rather than a redirect:
 * a redirect fired from a background refetch would throw away whatever the
 * person was in the middle of typing.
 *
 * Once raised the flag stays raised for the life of the page. Clearing it on
 * the next successful call would be wrong — polls like `/api/setup/status`
 * never touch the user's token and would succeed straight through a dead
 * authorization, blinking the banner away. Signing in again reloads the SPA,
 * which resets this.
 */

let needed = false;
const listeners = new Set<() => void>();

export function noteReauthNeeded(): void {
  if (needed) return;
  needed = true;
  for (const l of listeners) l();
}

export function useReauthNeeded(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => needed,
    () => false,
  );
}
