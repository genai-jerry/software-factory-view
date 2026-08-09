import { SignJWT, importPKCS8 } from "jose";
import sodium from "libsodium-wrappers";

/**
 * Thin GitHub REST client with the two-token model as a *structural* property
 * (spec 01 §2.1): `InstallationClient` (the app's identity — reads, onboarding
 * automation, non-authoritative comments) and `UserClient` (the human's OAuth
 * identity — everything carrying authority). Authoritative operations exist
 * only on UserClient, so "approve as the app" is not expressible.
 */

export interface GitHubConfig {
  apiUrl: string;
  appId: string;
  privateKeyPem: string;
  oauthClientId: string;
  oauthClientSecret: string;
}

export class GitHubHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`GitHub ${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
  }
}

async function ghFetch(
  apiUrl: string,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "factory-console",
    ...extraHeaders,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  if (res.status >= 400) throw new GitHubHttpError(res.status, method, path, text);
  return { status: res.status, json, headers: res.headers };
}

/** App-level auth: JWT minting and installation token exchange. Tokens are never persisted. */
export class AppAuth {
  private cache = new Map<number, { token: string; expiresAt: number }>();
  constructor(private readonly cfg: GitHubConfig) {}

  async appJwt(): Promise<string> {
    const key = await importPKCS8(normalisePem(this.cfg.privateKeyPem), "RS256");
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(now - 30)
      .setExpirationTime(now + 9 * 60)
      .setIssuer(this.cfg.appId)
      .sign(key);
  }

  async installationToken(installationId: number): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const jwt = await this.appJwt();
    const { json } = await ghFetch(this.cfg.apiUrl, jwt, "POST", `/app/installations/${installationId}/access_tokens`);
    const data = json as { token: string; expires_at: string };
    this.cache.set(installationId, { token: data.token, expiresAt: Date.parse(data.expires_at) });
    return data.token;
  }

  async exchangeOAuthCode(code: string, githubWebUrl: string): Promise<{ accessToken: string }> {
    const res = await fetch(`${githubWebUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: this.cfg.oauthClientId,
        client_secret: this.cfg.oauthClientSecret,
        code,
      }),
    });
    const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!data.access_token) throw new Error(`OAuth exchange failed: ${data.error ?? "no token"} ${data.error_description ?? ""}`);
    return { accessToken: data.access_token };
  }
}

function normalisePem(pem: string): string {
  // Accept PKCS#1 keys ("BEGIN RSA PRIVATE KEY") by failing loudly with advice,
  // since jose requires PKCS#8. GitHub App keys download as PKCS#1.
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is PKCS#1. Convert once with: openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem",
    );
  }
  return pem;
}

/* ---------------------------------- shared read surface ---------------------------------- */

export interface GhIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  state: string;
  body: string | null;
  user: { login: string } | null;
  labels: Array<{ name: string } | string>;
  updated_at: string;
  created_at: string;
  closed_at: string | null;
  pull_request?: unknown;
  html_url: string;
}

export interface GhComment {
  id: number;
  node_id: string;
  body: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface GhPull {
  id: number;
  node_id: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string } | null;
  updated_at: string;
  html_url: string;
  mergeable?: boolean | null;
}

export interface GhWorkflowRun {
  id: number;
  node_id: string;
  name: string | null;
  status: string;
  conclusion: string | null;
  event: string;
  head_branch: string | null;
  html_url: string;
  run_started_at?: string;
  created_at: string;
  updated_at: string;
}

/** Read + non-authoritative operations, shared by both identities. */
export class RepoReader {
  constructor(
    protected readonly apiUrl: string,
    protected readonly tokenProvider: () => Promise<string>,
  ) {}

  protected async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.tokenProvider();
    const { json } = await ghFetch(this.apiUrl, token, method, path, body);
    return json;
  }

  async getRepo(owner: string, repo: string): Promise<{ node_id: string; default_branch: string; full_name: string; private: boolean }> {
    return (await this.req("GET", `/repos/${owner}/${repo}`)) as never;
  }

  async listIssues(owner: string, repo: string, page = 1): Promise<GhIssue[]> {
    return (await this.req(
      "GET",
      `/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}&sort=updated&direction=desc`,
    )) as GhIssue[];
  }

  async getIssue(owner: string, repo: string, num: number): Promise<GhIssue> {
    return (await this.req("GET", `/repos/${owner}/${repo}/issues/${num}`)) as GhIssue;
  }

  async listIssueComments(owner: string, repo: string, num: number, page = 1): Promise<GhComment[]> {
    return (await this.req("GET", `/repos/${owner}/${repo}/issues/${num}/comments?per_page=100&page=${page}`)) as GhComment[];
  }

  async listIssueEvents(owner: string, repo: number | string, num: number, page = 1): Promise<unknown[]> {
    return (await this.req("GET", `/repos/${owner}/${repo}/issues/${num}/events?per_page=100&page=${page}`)) as unknown[];
  }

  async listPulls(owner: string, repo: string, page = 1): Promise<GhPull[]> {
    return (await this.req(
      "GET",
      `/repos/${owner}/${repo}/pulls?state=all&per_page=100&page=${page}&sort=updated&direction=desc`,
    )) as GhPull[];
  }

  async getPull(owner: string, repo: string, num: number): Promise<GhPull> {
    return (await this.req("GET", `/repos/${owner}/${repo}/pulls/${num}`)) as GhPull;
  }

  async listPullFiles(owner: string, repo: string, num: number): Promise<Array<{ filename: string; status: string }>> {
    return (await this.req("GET", `/repos/${owner}/${repo}/pulls/${num}/files?per_page=100`)) as never;
  }

  async listWorkflowRuns(owner: string, repo: string, page = 1): Promise<{ workflow_runs: GhWorkflowRun[] }> {
    return (await this.req("GET", `/repos/${owner}/${repo}/actions/runs?per_page=50&page=${page}`)) as never;
  }

  /** Contents API at a specific ref; returns decoded text or null for 404. */
  async getFileAtRef(owner: string, repo: string, path: string, ref?: string): Promise<{ content: string; sha: string } | null> {
    try {
      const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const json = (await this.req("GET", `/repos/${owner}/${repo}/contents/${encodePath(path)}${q}`)) as {
        content?: string;
        encoding?: string;
        sha: string;
      };
      if (json.content === undefined) return null; // a directory
      const buf = Buffer.from(json.content, (json.encoding as BufferEncoding) ?? "base64");
      return { content: buf.toString("utf8"), sha: json.sha };
    } catch (e) {
      if (e instanceof GitHubHttpError && e.status === 404) return null;
      throw e;
    }
  }

  async listDir(owner: string, repo: string, path: string, ref?: string): Promise<Array<{ path: string; type: string; sha: string }>> {
    try {
      const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const json = await this.req("GET", `/repos/${owner}/${repo}/contents/${encodePath(path)}${q}`);
      return Array.isArray(json) ? (json as never) : [];
    } catch (e) {
      if (e instanceof GitHubHttpError && e.status === 404) return [];
      throw e;
    }
  }

  async getBranchHeadSha(owner: string, repo: string, branch: string): Promise<string | null> {
    try {
      const json = (await this.req("GET", `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`)) as {
        commit: { sha: string };
      };
      return json.commit.sha;
    } catch (e) {
      if (e instanceof GitHubHttpError && e.status === 404) return null;
      throw e;
    }
  }

  async listCollaborators(owner: string, repo: string): Promise<Array<{ login: string; permissions?: Record<string, boolean> }>> {
    return (await this.req("GET", `/repos/${owner}/${repo}/collaborators?per_page=100`)) as never;
  }

  /** Sub-issues API — the authoritative parent/child relation the reconciler repairs against. */
  async listSubIssues(owner: string, repo: string, num: number): Promise<GhIssue[]> {
    try {
      return (await this.req("GET", `/repos/${owner}/${repo}/issues/${num}/sub_issues?per_page=100`)) as GhIssue[];
    } catch (e) {
      if (e instanceof GitHubHttpError && (e.status === 404 || e.status === 410)) return [];
      throw e;
    }
  }

  async listLabels(owner: string, repo: string): Promise<Array<{ name: string; color: string; description: string | null }>> {
    return (await this.req("GET", `/repos/${owner}/${repo}/labels?per_page=100`)) as never;
  }
}

/* ---------------------------------- installation client ---------------------------------- */

/**
 * The app's identity. Reads, onboarding automation, config PRs. There is
 * deliberately no merge / no gate-comment method here.
 */
export class InstallationClient extends RepoReader {
  constructor(apiUrl: string, auth: AppAuth, installationId: number) {
    super(apiUrl, () => auth.installationToken(installationId));
  }

  async createLabel(owner: string, repo: string, label: { name: string; color: string; description: string }): Promise<"created" | "updated"> {
    try {
      await this.req("POST", `/repos/${owner}/${repo}/labels`, label);
      return "created";
    } catch (e) {
      if (e instanceof GitHubHttpError && e.status === 422) {
        await this.req("PATCH", `/repos/${owner}/${repo}/labels/${encodeURIComponent(label.name)}`, label);
        return "updated";
      }
      throw e;
    }
  }

  async putActionsSecret(owner: string, repo: string, name: string, value: string): Promise<void> {
    const keyInfo = (await this.req("GET", `/repos/${owner}/${repo}/actions/secrets/public-key`)) as {
      key_id: string;
      key: string;
    };
    await sodium.ready;
    const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(keyInfo.key, sodium.base64_variants.ORIGINAL));
    await this.req("PUT", `/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(name)}`, {
      encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
      key_id: keyInfo.key_id,
    });
  }

  async getActionsSecret(owner: string, repo: string, name: string): Promise<boolean> {
    try {
      await this.req("GET", `/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(name)}`);
      return true;
    } catch (e) {
      if (e instanceof GitHubHttpError && e.status === 404) return false;
      throw e;
    }
  }

  async createBranch(owner: string, repo: string, branch: string, fromSha: string): Promise<void> {
    await this.req("POST", `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: fromSha });
  }

  async putFile(
    owner: string,
    repo: string,
    path: string,
    opts: { message: string; content: string; branch: string; sha?: string },
  ): Promise<void> {
    await this.req("PUT", `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
      message: opts.message,
      content: Buffer.from(opts.content, "utf8").toString("base64"),
      branch: opts.branch,
      ...(opts.sha ? { sha: opts.sha } : {}),
    });
  }

  async createPull(
    owner: string,
    repo: string,
    opts: { title: string; head: string; base: string; body: string },
  ): Promise<{ number: number; html_url: string }> {
    return (await this.req("POST", `/repos/${owner}/${repo}/pulls`, opts)) as never;
  }

  /** Non-authoritative comment as the app (never used for approvals). */
  async createAppComment(owner: string, repo: string, issueNumber: number, body: string): Promise<GhComment> {
    return (await this.req("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body })) as GhComment;
  }
}

/* ---------------------------------- user client ---------------------------------- */

/**
 * The human's identity. The only place authoritative operations exist. A user
 * who cannot comment/merge on GitHub cannot do it here either — GitHub's own
 * permission check runs on every call.
 */
export class UserClient extends RepoReader {
  constructor(apiUrl: string, userToken: string) {
    super(apiUrl, async () => userToken);
  }

  async me(): Promise<{ id: number; login: string; name: string | null; avatar_url: string }> {
    return (await this.req("GET", "/user")) as never;
  }

  async createComment(owner: string, repo: string, issueNumber: number, body: string): Promise<GhComment> {
    return (await this.req("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body })) as GhComment;
  }

  async mergePull(
    owner: string,
    repo: string,
    prNumber: number,
    opts?: { method?: "merge" | "squash" | "rebase" },
  ): Promise<{ sha: string; merged: boolean }> {
    return (await this.req("PUT", `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      merge_method: opts?.method ?? "squash",
    })) as never;
  }

  async addLabels(owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
    await this.req("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, { labels });
  }

  async removeLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<void> {
    try {
      await this.req("DELETE", `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
    } catch (e) {
      if (e instanceof GitHubHttpError && e.status === 404) return;
      throw e;
    }
  }

  async closeIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
    await this.req("PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, { state: "closed" });
  }

  async createIssue(owner: string, repo: string, opts: { title: string; body: string; labels?: string[] }): Promise<GhIssue> {
    return (await this.req("POST", `/repos/${owner}/${repo}/issues`, opts)) as GhIssue;
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
