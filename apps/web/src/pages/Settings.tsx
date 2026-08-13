import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import type { Me, OrgSettings, SecretWriteResult } from "../types.js";

const MODEL_SUGGESTIONS = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"];

/**
 * Org settings: each org names its own Ask-the-Factory model and API key,
 * and can write an agent token to every connected repo's GitHub Actions
 * secrets in one pass (the Console never stores that value).
 */
export function SettingsPage({ me }: { me: Me }) {
  return (
    <div>
      <h1>Settings</h1>
      {me.orgs.map((o) => (
        <OrgSettingsCard key={o.id} orgId={o.id} />
      ))}
      {me.orgs.length === 0 && <p className="muted">No orgs yet — connect an estate first.</p>}
    </div>
  );
}

function OrgSettingsCard({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["org-settings", orgId],
    queryFn: () => api.get<OrgSettings>(`/api/orgs/${orgId}/settings`),
  });
  if (settings.isLoading) return <p className="muted">Loading…</p>;
  if (!settings.data) return null;
  const s = settings.data;
  const canEdit = s.role === "owner" || s.role === "admin";
  return (
    <div className="card">
      <h2>{s.name}</h2>
      {!canEdit && <p className="muted">You have the {s.role} role here — settings are read-only for you.</p>}
      <InsightSection orgId={orgId} settings={s} canEdit={canEdit} onSaved={() => void qc.invalidateQueries({ queryKey: ["org-settings", orgId] })} />
      <SecretsSection orgId={orgId} settings={s} canEdit={canEdit} />
    </div>
  );
}

function InsightSection({
  orgId,
  settings: s,
  canEdit,
  onSaved,
}: {
  orgId: string;
  settings: OrgSettings;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [model, setModel] = useState(s.insight.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const save = useMutation({
    mutationFn: (body: { model?: string | null; apiKey?: string | null }) =>
      api.post(`/api/orgs/${orgId}/settings/insight`, body),
    onSuccess: () => {
      setApiKey("");
      onSaved();
    },
  });

  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <h3>Ask the Factory</h3>
      <p className="muted">
        The model and Anthropic <strong>API key</strong> this org's Q&A runs on. The key must be an API key from
        platform.claude.com (<code>sk-ant-api…</code>) — a Claude Code OAuth token authenticates the factory's agents, not
        direct API calls, and will be rejected.
        {s.insight.globalKeyConfigured && " Without an org key, the Console's instance-wide key is used."}
      </p>
      <div className="row">
        <label style={{ minWidth: "4.5rem" }}>Model</label>
        <input
          list={`models-${orgId}`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={`default: ${s.insight.defaultModel}`}
          disabled={!canEdit}
          style={{ width: "18rem" }}
        />
        <datalist id={`models-${orgId}`}>
          {MODEL_SUGGESTIONS.map((m) => (
            <option value={m} key={m} />
          ))}
        </datalist>
      </div>
      <div className="row" style={{ marginTop: "0.4rem" }}>
        <label style={{ minWidth: "4.5rem" }}>API key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={s.insight.hasKey ? "key is set — enter a new one to replace it" : "sk-ant-api…"}
          disabled={!canEdit}
          style={{ width: "18rem" }}
        />
        <span className="badge">{s.insight.hasKey ? "key set" : s.insight.globalKeyConfigured ? "using instance key" : "no key"}</span>
      </div>
      {save.isError && <div className="banner error" style={{ marginTop: "0.5rem" }}>{(save.error as ApiError).message}</div>}
      {canEdit && (
        <div className="row" style={{ marginTop: "0.6rem" }}>
          <button
            className="primary"
            disabled={save.isPending}
            onClick={() => save.mutate({ model: model || null, ...(apiKey ? { apiKey } : {}) })}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          {s.insight.hasKey && (
            <button disabled={save.isPending} onClick={() => save.mutate({ apiKey: null })}>
              Clear key
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SecretsSection({ orgId, settings: s, canEdit }: { orgId: string; settings: OrgSettings; canEdit: boolean }) {
  const [name, setName] = useState(s.allowedSecrets[1] ?? "CLAUDE_CODE_OAUTH_TOKEN");
  const [value, setValue] = useState("");
  const write = useMutation({
    mutationFn: () => api.post<SecretWriteResult>(`/api/orgs/${orgId}/settings/secrets`, { name, value }),
    onSuccess: () => setValue(""),
  });

  return (
    <div>
      <h3>Agent token → GitHub secrets</h3>
      <p className="muted">
        Writes the token straight to every connected repo's GitHub Actions secrets — the value never touches the Console's
        database. This is the credential the factory's agents run on (per-repo control lives in Onboarding → step 2).
      </p>
      <div className="row">
        <select value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} style={{ width: "auto" }}>
          {s.allowedSecrets.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="token value"
          disabled={!canEdit}
          style={{ width: "18rem" }}
        />
        <button className="primary" disabled={!canEdit || !value || write.isPending} onClick={() => write.mutate()}>
          {write.isPending ? "Writing…" : "Write to all repos"}
        </button>
      </div>
      {write.isError && <div className="banner error" style={{ marginTop: "0.5rem" }}>{(write.error as ApiError).message}</div>}
      {write.data && (
        <div style={{ marginTop: "0.5rem" }}>
          {write.data.results.map((r) => (
            <div className="check-row" key={r.repo}>
              <span className={`check-icon ${r.ok ? "ok" : "fail"}`}>{r.ok ? "✓" : "✗"}</span>
              <span style={{ flex: 1 }}>{r.repo}</span>
              {r.error && <span className="muted">{r.error}</span>}
            </div>
          ))}
          {write.data.results.length === 0 && <p className="muted">No connected repos in this org yet.</p>}
        </div>
      )}
    </div>
  );
}
