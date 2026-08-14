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

  /** The authenticated App (app JWT). Used to recover the slug when credentials come from the environment. */
  async appInfo(): Promise<{ id: number; slug: string; name: string; html_url: string; client_id: string }> {
    const jwt = await this.appJwt();
    const { json } = await ghFetch(this.cfg.apiUrl, jwt, "GET", "/app");
    return json as never;
  }

  /** Every installation of this App (app JWT). */
  async listInstallations(): Promise<Array<{ id: number; account: { login: string; type?: string } }>> {
    const jwt = await this.appJwt();
    const { json } = await ghFetch(this.cfg.apiUrl, jwt, "GET", "/app/installations?per_page=100");
    return json as never;
  }

  /** Convert a manifest code into a full credential set (two-click App registration). */
  async convertManifest(code: string): Promise<{
    id: number;
    slug: string;
    html_url: string;
    pem: string;
    webhook_secret: string;
    client_id: string;
    client_secret: string;
  }> {
    const { json } = await ghFetch(this.cfg.apiUrl, null, "POST", `/app-manifests/${encodeURIComponent(code)}/conversions`);
    return json as never;
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
  assignees?: Array<{ login: string }> | null;
  milestone?: { number: number; title: string } | null;
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

export interface GhRepoSummary {
  id: number;
  node_id: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  owner: { id: number; login: string; type?: string; avatar_url?: string };
}

export interface GhAccountSummary {
  id: number;
  login: string;
  type?: string;
  avatar_url?: string;
}

/**
 * GitHub App install URL that pre-selects an account and repositories.
 *
 * GitHub only honours repository pre-selection on `/installations/new/permissions`
 * with `suggested_target_id` (not `target_id`) plus `repository_ids[]`. Omit the
 * repo ids and GitHub defaults to "All repositories", which forces the user to
 * pick again after they already chose in the Console.
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/migrating-oauth-apps-to-github-apps
 */
export function githubAppInstallUrl(opts: {
  webUrl: string;
  slug: string;
  accountId?: number | null;
  repositoryIds?: number[];
  state?: string;
}): string {
  const web = opts.webUrl.replace(/\/$/, "");
  const repoIds = (opts.repositoryIds ?? []).filter((id) => id > 0).slice(0, 100);
  const usePermissions = Boolean(opts.accountId) || repoIds.length > 0;
  const path = usePermissions
    ? `${web}/apps/${opts.slug}/installations/new/permissions`
    : `${web}/apps/${opts.slug}/installations/new`;
  const parts: string[] = [];
  if (opts.accountId) parts.push(`suggested_target_id=${opts.accountId}`);
  for (const id of repoIds) parts.push(`repository_ids[]=${id}`);
  if (opts.state) parts.push(`state=${encodeURIComponent(opts.state)}`);
  return parts.length ? `${path}?${parts.join("&")}` : path;
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

  /** Follow page= until a short page, capped so a huge org cannot stall onboarding. */
  protected async paginate<T>(path: string, unwrap: (json: unknown) => T[], perPage = 100, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const json = await this.req("GET", `${path}${sep}per_page=${perPage}&page=${page}`);
      const chunk = unwrap(json);
      out.push(...chunk);
      if (chunk.length < perPage) break;
    }
    return out;
  }

  protected async tryPaginate<T>(path: string, unwrap: (json: unknown) => T[]): Promise<T[]> {
    try {
      return await this.paginate(path, unwrap);
    } catch (e) {
      if (e instanceof GitHubHttpError && (e.status === 403 || e.status === 404)) return [];
      throw e;
    }
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

  /**
   * Issues carrying a label, open or closed — by label and never by search,
   * because the search index lags issue creation by seconds to minutes and a
   * singleton issue looked up too soon gets filed twice.
   */
  async listIssuesByLabel(owner: string, repo: string, label: string): Promise<GhIssue[]> {
    const rows = (await this.req(
      "GET",
      `/repos/${owner}/${repo}/issues?state=all&per_page=100&labels=${encodeURIComponent(label)}`,
    )) as Array<GhIssue & { pull_request?: unknown }>;
    return rows.filter((i) => !i.pull_request);
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

  /**
   * Native issue-dependency relations (issues this one is blocked by) — the
   * authoritative dependency source when the plan/API version offers it.
   * Absence (404/410) and lack of entitlement (403) degrade to an empty list,
   * leaving body-marker parsing as the only source for that estate.
   */
  async listBlockedBy(owner: string, repo: string, num: number): Promise<GhIssue[]> {
    try {
      return (await this.req("GET", `/repos/${owner}/${repo}/issues/${num}/dependencies/blocked_by?per_page=100`)) as GhIssue[];
    } catch (e) {
      if (e instanceof GitHubHttpError && (e.status === 403 || e.status === 404 || e.status === 410)) return [];
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

  /**
   * App installations this *user* can see — the visibility floor for the
   * connect-an-estate flow: you can only wire up an installation on an org you
   * are actually a member of.
   */
  async listMyInstallations(): Promise<
    Array<{ id: number; account: { id?: number; login: string; type?: string; avatar_url?: string } }>
  > {
    return this.paginate("/user/installations", (json) => {
      const data = json as { installations?: Array<{ id: number; account: { id?: number; login: string; type?: string; avatar_url?: string } }> };
      return data.installations ?? [];
    });
  }

  /** Repositories the user can see within one installation. */
  async listInstallationRepos(
    installationId: number,
  ): Promise<Array<{ id: number; node_id: string; full_name: string; default_branch: string; private: boolean }>> {
    return this.paginate(`/user/installations/${installationId}/repositories`, (json) => {
      const data = json as {
        repositories?: Array<{ id: number; node_id: string; full_name: string; default_branch: string; private: boolean }>;
      };
      return data.repositories ?? [];
    });
  }

  /**
   * Accounts (personal + orgs) and repositories this GitHub user can see,
   * including ones the App is not installed on yet. GitHub App user tokens
   * only return installed repos from /user/repos, so public listing fills
   * the gap that otherwise leaves a first-time sign-in looking empty.
   */
  async listAccessibleAccounts(login: string): Promise<Array<{ account: GhAccountSummary; repos: GhRepoSummary[] }>> {
    const byLogin = new Map<string, { account: GhAccountSummary; repos: Map<number, GhRepoSummary> }>();

    const addAccount = (account: GhAccountSummary) => {
      const key = account.login.toLowerCase();
      const existing = byLogin.get(key);
      if (!existing) {
        byLogin.set(key, { account, repos: new Map() });
        return;
      }
      if (!existing.account.id && account.id) existing.account.id = account.id;
      if (!existing.account.avatar_url && account.avatar_url) existing.account.avatar_url = account.avatar_url;
      if (!existing.account.type && account.type) existing.account.type = account.type;
    };

    const addRepo = (repo: GhRepoSummary) => {
      if (!repo?.full_name || !repo.owner?.login) return;
      addAccount({
        id: repo.owner.id,
        login: repo.owner.login,
        type: repo.owner.type ?? "User",
        avatar_url: repo.owner.avatar_url,
      });
      const bucket = byLogin.get(repo.owner.login.toLowerCase())!;
      if (repo.id) bucket.repos.set(repo.id, repo);
    };

    const asRepos = (json: unknown) => (Array.isArray(json) ? (json as GhRepoSummary[]) : []);
    const asOrgs = (json: unknown) => (Array.isArray(json) ? (json as GhAccountSummary[]) : []);

    try {
      const me = await this.me();
      addAccount({ id: me.id, login: me.login, type: "User", avatar_url: me.avatar_url });
    } catch (e) {
      if (!(e instanceof GitHubHttpError && (e.status === 403 || e.status === 404))) throw e;
      addAccount({ id: 0, login, type: "User" });
    }

    for (const repo of await this.tryPaginate("/user/repos?affiliation=owner,collaborator,organization_member&sort=updated", asRepos)) {
      addRepo(repo);
    }
    for (const repo of await this.tryPaginate(`/users/${encodeURIComponent(login)}/repos?type=owner&sort=updated`, asRepos)) {
      addRepo(repo);
    }

    const orgs = new Map<string, GhAccountSummary>();
    const ingestOrg = (org: GhAccountSummary | undefined) => {
      if (!org?.login) return;
      orgs.set(org.login.toLowerCase(), { id: org.id, login: org.login, type: "Organization", avatar_url: org.avatar_url });
    };
    for (const org of await this.tryPaginate("/user/orgs", asOrgs)) ingestOrg(org);
    for (const row of await this.tryPaginate("/user/memberships/orgs?state=active", (json) => {
      const data = Array.isArray(json) ? (json as Array<{ organization?: GhAccountSummary }>) : [];
      return data;
    })) {
      ingestOrg(row.organization);
    }
    for (const org of await this.tryPaginate(`/users/${encodeURIComponent(login)}/orgs`, asOrgs)) ingestOrg(org);

    for (const org of orgs.values()) {
      addAccount(org);
      for (const repo of await this.tryPaginate(`/orgs/${encodeURIComponent(org.login)}/repos?type=all&sort=updated`, asRepos)) {
        addRepo(repo);
      }
    }

    return [...byLogin.values()].map(({ account, repos }) => ({ account, repos: [...repos.values()] }));
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

  async reopenIssue(owner: string, repo: string, issueNumber: number): Promise<void> {
    await this.req("PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, { state: "open" });
  }

  async createIssue(owner: string, repo: string, opts: { title: string; body: string; labels?: string[] }): Promise<GhIssue> {
    return (await this.req("POST", `/repos/${owner}/${repo}/issues`, opts)) as GhIssue;
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
