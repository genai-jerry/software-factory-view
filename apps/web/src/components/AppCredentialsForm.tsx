import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import type { SetupStatus } from "../types.js";

/**
 * GitHub App registration by hand: the five values from an App's settings page,
 * typed in rather than handed over by GitHub's manifest flow.
 *
 * The manifest flow is the better path when it works, but it requires github.com
 * to reach this Console (it posts a manifest and redirects back). On a laptop,
 * behind a firewall, or with an App that already exists, this form is the way
 * in — and it is the only way to point an existing install at a different App.
 *
 * It doubles as the edit form. Once a registration is stored the identifiers
 * prefill and the secrets do not: the API keeps whatever is left blank, so
 * rotating a client secret is one field rather than five.
 */
export function AppCredentialsForm({ status, onSaved }: { status: SetupStatus; onSaved: () => void }) {
  // Only a stored registration can be patched field by field. Credentials that
  // come from the environment, or a row that cannot be decrypted, need the full
  // set — entering it is what replaces them.
  const editing = status.source === "database";
  const [appId, setAppId] = useState(status.appId ?? "");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [clientId, setClientId] = useState(status.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [slug, setSlug] = useState(status.appSlug ?? "");

  const save = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; appId: string }>("/api/setup/credentials", {
        appId,
        privateKeyPem,
        webhookSecret,
        clientId,
        clientSecret,
        slug,
      }),
    onSuccess: () => {
      setPrivateKeyPem("");
      setClientSecret("");
      setWebhookSecret("");
      onSaved();
    },
  });

  // Blanks keep the stored values, which is only ever right for the same App:
  // a different App ID needs its own key, a different client id its own secret.
  const newApp = editing && appId.trim() !== (status.appId ?? "");
  const newClient = editing && clientId.trim() !== (status.clientId ?? "");
  const complete = editing
    ? Boolean(appId.trim() && clientId.trim() && (!newApp || privateKeyPem.trim()) && (!newClient || clientSecret.trim()))
    : Boolean(appId.trim() && privateKeyPem.trim() && clientId.trim() && clientSecret.trim());
  const keep = "leave blank to keep the stored value";

  return (
    <div>
      <p className="muted">
        From the App's page in GitHub: <strong>Settings → Developer settings → GitHub Apps → your App</strong>. The App ID and
        Client ID are on that page; generate a private key and a client secret there too. The key may be the PKCS#1 file GitHub
        gives you — it is converted for you.
      </p>
      {editing && (
        <p className="muted">
          Editing the stored registration. Change only what you need — every secret below is optional, and anything left blank
          stays as it is.
        </p>
      )}
      {(newApp || newClient) && (
        <div className="banner info">
          That is a different {newApp ? "App" : "OAuth client"}, so blanks cannot carry over: paste{" "}
          {newApp && <>the new App's private key</>}
          {newApp && newClient && " and "}
          {newClient && <>its client secret</>} too.
        </div>
      )}
      {!status.canEditApp && (
        <div className="banner error">
          <strong>Only a factory admin can save these.</strong> Pin{" "}
          <code>GITHUB_APP_ID</code>, <code>GITHUB_APP_PRIVATE_KEY</code>, <code>GITHUB_OAUTH_CLIENT_ID</code> and{" "}
          <code>GITHUB_OAUTH_CLIENT_SECRET</code> as host secrets if sign-in itself is broken.
        </div>
      )}
      <p>
        <label className="muted">App ID (numeric)</label>
        <input inputMode="numeric" placeholder="123456" value={appId} onChange={(e) => setAppId(e.target.value)} />
      </p>
      <p>
        <label className="muted">App slug (optional — the name in its github.com/apps/… URL)</label>
        <input placeholder="factory-console" value={slug} onChange={(e) => setSlug(e.target.value)} />
      </p>
      <p>
        <label className="muted">Private key (.pem, BEGIN/END lines included){editing && ` — ${keep}`}</label>
        <textarea
          rows={5}
          placeholder={
            editing ? "A key is stored — paste a new .pem only to replace it" : "-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"
          }
          value={privateKeyPem}
          onChange={(e) => setPrivateKeyPem(e.target.value)}
          style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8rem" }}
        />
      </p>
      <p>
        <label className="muted">OAuth Client ID</label>
        <input placeholder="Iv1.…" value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </p>
      <p>
        <label className="muted">OAuth Client secret{editing && ` — ${keep}`}</label>
        <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
      </p>
      <p>
        <label className="muted">Webhook secret{editing && status.hasWebhookSecret && ` — ${keep}`}</label>
        <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} />
        {!webhookSecret && !status.hasWebhookSecret && (
          <span className="muted">
            Leave blank only if the App has no webhook secret — the Console rejects unverified deliveries, so updates will then
            arrive only when you reconcile.
          </span>
        )}
      </p>
      <p className="muted">
        On the App&apos;s GitHub page, also set: Webhook URL{" "}
        <code>{status.publicOrigin}/webhooks/github</code>; Callback URL (Identifying and authorizing users){" "}
        <code>{status.publicOrigin}/auth/github/callback</code>; and Advanced → Danger zone → Make public so any GitHub
        user can sign in. A private App 404s on Sign in with GitHub for everyone except its owner.
      </p>
      {save.isError && <div className="banner error">{(save.error as ApiError).message}</div>}
      {save.isSuccess && (
        <div className="banner info">
          {editing ? "Saved" : "Credentials stored"} — the Console is using App {save.data.appId}.
        </div>
      )}
      <p>
        <button
          className="primary"
          disabled={!complete || !status.hasMasterKey || !status.canEditApp || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : editing ? "Save changes" : "Save credentials"}
        </button>
      </p>
    </div>
  );
}
