import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import type { Me, OrgSettings, SecretWriteResult } from "../types.js";

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  grok: "Grok (xAI)",
  openrouter: "OpenRouter",
};

const MODEL_SUGGESTIONS: Record<string, string[]> = {
  anthropic: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"],
  openai: ["gpt-5.1", "gpt-5", "gpt-4.1-mini"],
  grok: ["grok-4", "grok-4-fast"],
  openrouter: ["anthropic/claude-sonnet-4.5", "openai/gpt-5.1", "x-ai/grok-4"],
};

const KEY_PLACEHOLDERS: Record<string, string> = {
  anthropic: "sk-ant-api…",
  openai: "sk-…",
  grok: "xai-…",
  openrouter: "sk-or-…",
};

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
  const [provider, setProvider] = useState(s.insight.provider);
  const [model, setModel] = useState(s.insight.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const save = useMutation({
    mutationFn: (body: { provider?: string; model?: string | null; apiKey?: string | null }) =>
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
        The provider, model and <strong>API key</strong> this org's Q&A runs on. The key must be a direct API credential for
        the chosen provider — for Anthropic, a Claude Code OAuth token authenticates the factory's agents, not API calls, and
        will be rejected.
        {s.insight.globalKeyConfigured && " Without an org key, the Console's instance-wide Anthropic key is used."}
      </p>
      <div className="row">
        <label style={{ minWidth: "4.5rem" }}>Provider</label>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={!canEdit} style={{ width: "auto" }}>
          {s.insight.providers.map((p) => (
            <option value={p} key={p}>
              {PROVIDER_LABELS[p] ?? p}
            </option>
          ))}
        </select>
      </div>
      <div className="row" style={{ marginTop: "0.4rem" }}>
        <label style={{ minWidth: "4.5rem" }}>Model</label>
        <input
          list={`models-${orgId}-${provider}`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={provider === "anthropic" ? `default: ${s.insight.defaultModel}` : "model id (required)"}
          disabled={!canEdit}
          style={{ width: "18rem" }}
        />
        <datalist id={`models-${orgId}-${provider}`}>
          {(MODEL_SUGGESTIONS[provider] ?? []).map((m) => (
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
          placeholder={s.insight.hasKey ? "key is set — enter a new one to replace it" : (KEY_PLACEHOLDERS[provider] ?? "api key")}
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
            disabled={save.isPending || (provider !== "anthropic" && !model)}
            onClick={() => save.mutate({ provider, model: model || null, ...(apiKey ? { apiKey } : {}) })}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
          {s.insight.hasKey && (
            <button disabled={save.isPending} onClick={() => save.mutate({ apiKey: null })}>
              Clear key
            </button>
          )}
          {provider !== "anthropic" && !model && <span className="muted">a model id is required for this provider</span>}
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
