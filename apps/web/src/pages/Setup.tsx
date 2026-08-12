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

        {s.credentialError && (
          <div className="banner error">
            <strong>Stored credentials could not be opened.</strong> {s.credentialError}
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
