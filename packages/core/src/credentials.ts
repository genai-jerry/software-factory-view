import { AppAuth, type GitHubConfig } from "./github.js";
import { decryptSecret } from "./crypto.js";

/**
 * Where the Console's own GitHub App credentials come from.
 *
 * Precedence: the database row (written by a factory admin in Settings) wins
 * over environment variables. Pin GITHUB_APP_* secrets to bootstrap sign-in;
 * an admin can rotate the App after logging in without a redeploy.
 *
 * CONSOLE_MASTER_KEY is the one credential that must live in the environment:
 * it is what decrypts everything else.
 */

export interface StoredAppConfig {
  appId: string;
  slug: string | null;
  encryptedPrivateKey: string;
  encryptedWebhookSecret: string;
  clientId: string;
  encryptedClientSecret: string;
}

export interface ResolvedAppCredentials {
  appId: string;
  slug: string | null;
  privateKeyPem: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  source: "database" | "environment";
}

export interface CredentialStoreOptions {
  masterKey: string;
  apiUrl: string;
  /** Reads the singleton config row, or null when the App is not registered yet. */
  load: () => Promise<StoredAppConfig | null>;
  /** Environment fallback, used only when no row exists. */
  env: {
    appId: string;
    privateKeyPem: string;
    webhookSecret: string;
    clientId: string;
    clientSecret: string;
  };
}

export class CredentialStore {
  private cached: ResolvedAppCredentials | null = null;
  private lastError: string | null = null;

  constructor(private readonly opts: CredentialStoreOptions) {}

  /** Drop the cache after the setup flow writes new credentials. */
  invalidate(): void {
    this.cached = null;
    this.lastError = null;
  }

  /**
   * Set when a stored registration exists but cannot be opened with the
   * current master key — the reason behind an otherwise puzzling
   * "unconfigured" state.
   */
  get credentialError(): string | null {
    return this.lastError;
  }

  async resolve(): Promise<ResolvedAppCredentials | null> {
    if (this.cached) return this.cached;
    this.lastError = null;

    const row = await this.opts.load();
    if (row) {
      try {
        this.cached = {
          appId: row.appId,
          slug: row.slug,
          privateKeyPem: decryptSecret(row.encryptedPrivateKey, this.opts.masterKey),
          webhookSecret: decryptSecret(row.encryptedWebhookSecret, this.opts.masterKey),
          clientId: row.clientId,
          clientSecret: decryptSecret(row.encryptedClientSecret, this.opts.masterKey),
          source: "database",
        };
        return this.cached;
      } catch (err) {
        // A row we cannot open must not brick the Console. Environment secrets
        // can still sign people in; a factory admin repairs the stored row in
        // Settings. Report unconfigured — loudly — instead of crash-looping.
        this.lastError =
          `the stored GitHub App registration cannot be decrypted (${(err as Error).message}). ` +
          "CONSOLE_MASTER_KEY has most likely changed since the App was registered. " +
          "Restore the original key, or set GITHUB_APP_* secrets and overwrite the stored row from Settings.";
      }
    }

    const env = this.opts.env;
    if (env.appId && env.privateKeyPem && env.clientId && env.clientSecret) {
      this.cached = {
        appId: env.appId,
        slug: null,
        privateKeyPem: env.privateKeyPem,
        webhookSecret: env.webhookSecret,
        clientId: env.clientId,
        clientSecret: env.clientSecret,
        source: "environment",
      };
      return this.cached;
    }

    return null;
  }

  async isConfigured(): Promise<boolean> {
    return (await this.resolve()) !== null;
  }

  /** The App auth handle, or null when the Console has no App registered yet. */
  async auth(): Promise<AppAuth | null> {
    const creds = await this.resolve();
    if (!creds) return null;
    const cfg: GitHubConfig = {
      apiUrl: this.opts.apiUrl,
      appId: creds.appId,
      privateKeyPem: creds.privateKeyPem,
      oauthClientId: creds.clientId,
      oauthClientSecret: creds.clientSecret,
    };
    return new AppAuth(cfg);
  }

  /** Throwing variant for paths that cannot proceed unconfigured. */
  async requireAuth(): Promise<AppAuth> {
    const auth = await this.auth();
    if (!auth) throw new Error(this.lastError ?? "no GitHub App registered — set GITHUB_APP_* secrets");
    return auth;
  }

  async webhookSecret(): Promise<string | null> {
    return (await this.resolve())?.webhookSecret ?? null;
  }
}

/**
 * GitHub App manifest (the two-click registration path). GitHub creates the
 * App from this document and hands back the app id, PEM, webhook secret and
 * OAuth pair in one exchange — replacing five copy-paste steps and the
 * PKCS#1→PKCS#8 conversion trap.
 */
export function buildAppManifest(publicOrigin: string, name: string): Record<string, unknown> {
  return {
    name,
    url: publicOrigin,
    hook_attributes: { url: `${publicOrigin}/webhooks/github`, active: true },
    redirect_url: `${publicOrigin}/setup/github-app/callback`,
    callback_urls: [`${publicOrigin}/auth/github/callback`],
    setup_url: `${publicOrigin}/onboarding`,
    public: false,
    request_oauth_on_install: false,
    default_permissions: {
      issues: "write",
      pull_requests: "write",
      contents: "write",
      actions: "read",
      checks: "read",
      workflows: "read",
      secrets: "write",
      members: "read",
      metadata: "read",
    },
    default_events: [
      "issues",
      "issue_comment",
      "label",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "push",
      "check_suite",
      "check_run",
      "workflow_run",
      "installation",
      "installation_repositories",
    ],
  };
}

/** GitHub returns PKCS#1 PEMs; jose needs PKCS#8. Convert once, at registration. */
export async function toPkcs8(pem: string): Promise<string> {
  if (pem.includes("BEGIN PRIVATE KEY")) return pem;
  const { createPrivateKey } = await import("node:crypto");
  const key = createPrivateKey(pem);
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}
