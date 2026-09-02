/** Fetch wrapper: same-origin cookie auth + the CSRF custom header on writes. */
import { noteReauthNeeded } from "./lib/reauth.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
  }

  /**
   * The API could not renew the GitHub authorization on its own — only a fresh
   * sign-in will do. Distinct from a plain 401 (no session at all), which the
   * app already handles by showing the front door.
   */
  get needsReauth(): boolean {
    return this.status === 401 && (this.body as { reauth?: boolean } | null)?.reauth === true;
  }
}

/** Send the browser through GitHub sign-in, returning to the current page. */
export function reauthenticate(): void {
  const next = `${location.pathname}${location.search}`;
  location.assign(`/auth/github/login?next=${encodeURIComponent(next)}`);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["x-console-csrf"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const message = (json as { error?: string } | null)?.error ?? `${method} ${path} failed (${res.status})`;
    const err = new ApiError(res.status, message, json);
    if (err.needsReauth) noteReauthNeeded();
    throw err;
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};
