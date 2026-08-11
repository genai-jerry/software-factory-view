import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.js";
import type { SetupStatus } from "../types.js";

/**
 * First-run screen. The only thing the operator must have arranged outside the
 * app is CONSOLE_MASTER_KEY (scripts/setup.sh generates it); everything about
 * the GitHub App is created from here.
 */
export function SetupPage() {
  const status = useQuery({ queryKey: ["setup"], queryFn: () => api.get<SetupStatus>("/api/setup/status") });
  const [org, setOrg] = useState("");
  const [name, setName] = useState("Factory Console");

  if (!status.data) return <div className="main">Loading…</div>;
  const s = status.data;

  return (
    <div className="login-page">
      <div className="login-card" style={{ maxWidth: "40rem", textAlign: "left" }}>
        <h2 style={{ textAlign: "center" }}>⚙ Set up Factory Console</h2>

        {!s.hasMasterKey && (
          <div className="banner error">
            <strong>CONSOLE_MASTER_KEY is not set.</strong> It encrypts GitHub tokens and cached repo content at rest, so setup
            cannot proceed without it. Run <code>./scripts/setup.sh</code> (or add{" "}
            <code>CONSOLE_MASTER_KEY=$(openssl rand -base64 32)</code> to <code>.env</code>) and restart the API.
          </div>
        )}

        {s.configured ? (
          <>
            <div className="banner info">
              GitHub App <strong>{s.appSlug ?? "(configured)"}</strong> is registered — credentials loaded from {s.source}.
            </div>
            <p className="muted">
              Next: install the App on the org whose repositories you want, then connect the estate from the Onboarding page.
            </p>
            <p>
              <a href="/">
                <button className="primary">Go to the Console</button>
              </a>
            </p>
          </>
        ) : (
          <>
            <p className="muted">
              The Console needs its own GitHub App — that is what lets it read your repositories, verify webhooks, and sign you
              in. Creating it here takes two clicks: GitHub builds the App from a manifest and hands the credentials straight
              back, so there is nothing to copy by hand.
            </p>
            <p>
              <label className="muted">App name (must be unique across GitHub)</label>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </p>
            <p>
              <label className="muted">Create it under an organisation (leave blank for your personal account)</label>
              <input placeholder="my-org" value={org} onChange={(e) => setOrg(e.target.value)} />
            </p>
            <p>
              <a href={`/setup/github-app?name=${encodeURIComponent(name)}${org ? `&org=${encodeURIComponent(org)}` : ""}`}>
                <button className="primary" disabled={!s.hasMasterKey || !name.trim()}>
                  Create the GitHub App →
                </button>
              </a>
            </p>
            <details>
              <summary className="muted">What it will ask for, and why</summary>
              <ul className="muted">
                <li>
                  <strong>Issues, Pull requests, Contents (write)</strong> — the Console opens config/enablement PRs and, under
                  your identity, posts gate approvals.
                </li>
                <li>
                  <strong>Actions, Checks, Workflows (read)</strong> — to show which agent ran and whether CI is green.
                </li>
                <li>
                  <strong>Secrets (write)</strong> — onboarding writes <code>ANTHROPIC_API_KEY</code> straight to the repo, so
                  it never passes through the Console's storage.
                </li>
                <li>
                  <strong>Members, Metadata (read)</strong> — to check that gate approvers are real collaborators.
                </li>
              </ul>
              <p className="muted">
                Webhook URL will be <code>{s.publicOrigin}/webhooks/github</code>. If that is not reachable from GitHub (a local
                run), the Console still works — connect the estate manually on the Onboarding page and reconcile; webhooks only
                make updates faster.
              </p>
            </details>
            <ManualCredentials origin={s.publicOrigin} disabled={!s.hasMasterKey} />

            {s.devLogin && (
              <p className="muted">
                Dev mode is on: you can also <a href="/auth/dev-login">sign in without GitHub</a> to look around first.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The other way in: register an App the operator created by hand. Needed where
 * the manifest flow does not fit — an App shared between a local run and
 * production, or one an org admin created — and it keeps production first-run
 * to the same screen, with the credentials going straight into the encrypted
 * store rather than onto the deployment host as environment variables.
 */
function ManualCredentials({ origin, disabled }: { origin: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [appId, setAppId] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setBusy(true);
    setError(null);
    api
      .post<{ slug: string }>("/api/setup/credentials", { appId, privateKeyPem, webhookSecret, clientId, clientSecret })
      .then(() => window.location.reload())
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} style={{ marginTop: "1rem" }}>
      <summary className="muted">Already created an App yourself? Enter its credentials</summary>

      <p className="muted" style={{ marginTop: "0.75rem" }}>
        Set these on the App in GitHub first — they are derived from this Console's origin, so they must match exactly:
      </p>
      <ul className="muted">
        <li>
          Callback URL <code>{origin}/auth/github/callback</code>
        </li>
        <li>
          Webhook URL <code>{origin}/webhooks/github</code>
        </li>
        <li>
          Setup URL <code>{origin}/onboarding</code>
        </li>
      </ul>
      <p className="muted">
        Leave <em>Expire user authorization tokens</em> off — the Console holds no refresh token, so your sign-in would lapse
        after a few hours. Permissions and events are the same list as above.
      </p>

      <p>
        <label className="muted">App ID</label>
        <input inputMode="numeric" placeholder="123456" value={appId} onChange={(e) => setAppId(e.target.value)} />
      </p>
      <p>
        <label className="muted">Client ID</label>
        <input placeholder="Iv1.0123456789abcdef" value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </p>
      <p>
        <label className="muted">Client secret</label>
        <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
      </p>
      <p>
        <label className="muted">Webhook secret (blank if the App has no webhook configured)</label>
        <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} />
      </p>
      <p>
        <label className="muted">Private key — paste the whole .pem file; no conversion needed</label>
        <textarea
          rows={6}
          spellCheck={false}
          placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"}
          value={privateKeyPem}
          onChange={(e) => setPrivateKeyPem(e.target.value)}
          style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}
        />
      </p>

      {error && <div className="banner error">{error}</div>}
      <p>
        <button className="primary" onClick={submit} disabled={disabled || busy || !appId || !privateKeyPem || !clientId || !clientSecret}>
          {busy ? "Checking with GitHub…" : "Save credentials"}
        </button>
      </p>
      <p className="muted">
        They are checked against GitHub before anything is stored, then encrypted with <code>CONSOLE_MASTER_KEY</code> and kept
        in the database — nothing is written to disk or to the environment.
      </p>
    </details>
  );
}
