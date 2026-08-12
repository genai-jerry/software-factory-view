import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import type { SetupStatus } from "../types.js";

/**
 * Manual GitHub App registration: the five values from an App's settings page,
 * typed in rather than handed over by GitHub's manifest flow.
 *
 * The manifest flow is the better path when it works, but it requires github.com
 * to reach this Console (it posts a manifest and redirects back). On a laptop,
 * behind a firewall, or with an App that already exists, this form is the way
 * in — and it is the only way to point an existing install at a different App.
 */
export function AppCredentialsForm({ status, onSaved }: { status: SetupStatus; onSaved: () => void }) {
  const [appId, setAppId] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [slug, setSlug] = useState("");

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

  const complete = appId.trim() && privateKeyPem.trim() && clientId.trim() && clientSecret.trim();

  return (
    <div>
      <p className="muted">
        From the App's page in GitHub: <strong>Settings → Developer settings → GitHub Apps → your App</strong>. The App ID and
        Client ID are on that page; generate a private key and a client secret there too. The key may be the PKCS#1 file GitHub
        gives you — it is converted for you.
      </p>
      <p>
        <label className="muted">App ID (numeric)</label>
        <input inputMode="numeric" placeholder="123456" value={appId} onChange={(e) => setAppId(e.target.value)} />
      </p>
      <p>
        <label className="muted">App slug (optional — the name in its github.com/apps/… URL)</label>
        <input placeholder="factory-console" value={slug} onChange={(e) => setSlug(e.target.value)} />
      </p>
      <p>
        <label className="muted">Private key (.pem, BEGIN/END lines included)</label>
        <textarea
          rows={5}
          placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;…&#10;-----END RSA PRIVATE KEY-----"
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
        <label className="muted">OAuth Client secret</label>
        <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
      </p>
      <p>
        <label className="muted">Webhook secret</label>
        <input type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} />
        {!webhookSecret && (
          <span className="muted">
            Leave blank only if the App has no webhook secret — the Console rejects unverified deliveries, so updates will then
            arrive only when you reconcile.
          </span>
        )}
      </p>
      <p className="muted">
        Set the App's Webhook URL to <code>{status.publicOrigin}/webhooks/github</code> and its Callback URL to{" "}
        <code>{status.publicOrigin}/auth/github/callback</code>.
      </p>
      {save.isError && <div className="banner error">{(save.error as ApiError).message}</div>}
      {save.isSuccess && <div className="banner info">Credentials stored — the Console is using App {save.data.appId}.</div>}
      <p>
        <button className="primary" disabled={!complete || !status.hasMasterKey || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Storing…" : "Save credentials"}
        </button>
      </p>
    </div>
  );
}
