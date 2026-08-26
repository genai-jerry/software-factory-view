import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import { AppCredentialsForm } from "../components/AppCredentialsForm.js";
import { RepoChip } from "../components/RepoChip.js";
import type { IngestionLog, Me, OrgSettings, ProjectsData, SecretWriteResult, SetupStatus } from "../types.js";

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
 * Org settings: each org picks its orchestrator (GitHub Actions or Software
 * Factory), names its Ask-the-Factory model and API key, and can write an
 * agent token. GitHub Actions secrets are only written when that engine is on.
 */
export function SettingsPage({ me }: { me: Me }) {
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api.get<SetupStatus>("/api/setup/status") });

  return (
    <div>
      <h1>Settings</h1>
      {setup.data?.canEditApp && setup.data && <GitHubAppSection status={setup.data} />}
      {setup.data?.canEditApp && <IngestionLogSection />}
      {me.orgs.map((o) => (
        <OrgSettingsCard key={o.id} orgId={o.id} />
      ))}
      {me.orgs.length === 0 && <p className="muted">No orgs yet — connect an organisation first.</p>}
    </div>
  );
}

function GitHubAppSection({ status }: { status: SetupStatus }) {
  const qc = useQueryClient();
  return (
    <div className="card">
      <h2>GitHub App</h2>
      <p className="muted">
        The factory is a SaaS: one GitHub App signs every customer in and is installed on every organisation that wants
        the factory. Prefer pinning it with <code>GITHUB_APP_*</code> secrets on the host. This form is for the GitHub
        App owner to set or rotate it after signing in.
      </p>
      {status.configured ? (
        <div className="banner info">
          App <strong>{status.appSlug ?? "(configured)"}</strong>
          {status.appId && (
            <>
              {" "}
              — App ID <code>{status.appId}</code>
            </>
          )}{" "}
          loaded from {status.source}. Webhook URL <code>{status.publicOrigin}/webhooks/github</code>. The App must be
          public (Advanced → Make public), its Callback URL must be{" "}
          <code>{status.publicOrigin}/auth/github/callback</code>, and Post installation → Setup URL must be{" "}
          <code>{status.publicOrigin}/setup/install</code> (with Redirect on update) or GitHub leaves people on the
          installation settings page instead of returning them to this wizard.
        </div>
      ) : (
        <div className="banner stale">No GitHub App is configured. Sign-in will not work until one is.</div>
      )}
      {status.credentialError && <div className="banner error">{status.credentialError}</div>}
      {status.canEditApp ? (
        <>
          <p className="muted">
            Or create one on GitHub from a manifest:{" "}
            <a href="/setup/github-app">Create the GitHub App</a>.
          </p>
          <AppCredentialsForm status={status} onSaved={() => void qc.invalidateQueries({ queryKey: ["setup"] })} />
        </>
      ) : (
        <p className="muted">Only the GitHub App owner can change these credentials.</p>
      )}
    </div>
  );
}

/**
 * The server-side pipeline, on the web (owner-only, like the App section):
 * webhook deliveries with the worker's processing errors, and reconcile runs.
 * This is the page to open when something "does not show up in the view" —
 * it answers whether GitHub delivered, whether the worker projected, and
 * whether syncs run, without shelling into the server.
 */
function IngestionLogSection() {
  const qc = useQueryClient();
  const log = useQuery({
    queryKey: ["ops-ingestion"],
    queryFn: () => api.get<IngestionLog>("/api/ops/ingestion"),
    refetchInterval: 15_000,
  });
  const replay = useMutation({
    mutationFn: () => api.post<{ ok: boolean; queued: number }>("/api/ops/ingestion/replay"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ops-ingestion"] }),
  });
  if (log.isError) return null; // not the App owner — the API said 403
  if (!log.data) return null;
  const { summary, deliveries, reconciles } = log.data;
  const when = (v: string | null) => (v ? new Date(v).toLocaleString() : "never");

  return (
    <div className="card">
      <h2>Ingestion log</h2>
      <p className="muted">
        What the server is doing with GitHub's webhooks and the nightly/on-demand syncs. Auto-refreshes every 15s. If work is
        missing from the views, this is where the pipeline says why.
      </p>
      {summary.total === 0 && (
        <div className="banner error">
          No webhook delivery has ever been recorded — check the GitHub App's webhook URL and secret, and that the Issues /
          Pull requests / Workflow runs events are ticked in the App's subscriptions.
        </div>
      )}
      {summary.pending > 0 && (
        <div className={`banner ${summary.failing > 0 ? "error" : "stale"}`}>
          {summary.pending} deliver{summary.pending === 1 ? "y" : "ies"} not yet processed
          {summary.failing > 0 && ` — ${summary.failing} failing (see the error column)`}. If this number does not drop, the
          worker or Redis is down. If the worker is back up but the number holds steady, these deliveries exhausted their
          retries while it was down — replay them from the ledger:{" "}
          <button disabled={replay.isPending} onClick={() => replay.mutate()} style={{ marginLeft: "0.4rem" }}>
            {replay.isPending ? "Queuing…" : replay.isSuccess ? `Replayed ${replay.data.queued} ✓` : `Replay ${summary.pending} unprocessed`}
          </button>
        </div>
      )}
      <p className="muted">
        Last received: {when(summary.lastReceivedAt)} · last processed: {when(summary.lastProcessedAt)} · {summary.total} recorded
      </p>

      <h3>Webhook deliveries</h3>
      {deliveries.length === 0 && <p className="muted">Nothing yet.</p>}
      {deliveries.map((d) => (
        <div className="check-row" key={d.deliveryGuid} title={d.deliveryGuid}>
          <span className={`check-icon ${d.processedAt ? "ok" : d.error ? "fail" : ""}`}>
            {d.processedAt ? "✓" : d.error ? "✗" : "…"}
          </span>
          <span style={{ minWidth: "11rem" }}>
            {d.event}
            {d.action ? `.${d.action}` : ""}
          </span>
          <span className="muted" style={{ minWidth: "16rem" }}>
            {d.repo ?? "—"}
          </span>
          <span className="muted">{new Date(d.receivedAt).toLocaleString()}</span>
          {d.error && <span className="muted" style={{ flex: 1 }}>{d.error}</span>}
        </div>
      ))}

      <h3 style={{ marginTop: "1rem" }}>Reconcile runs</h3>
      {reconciles.length === 0 && (
        <p className="muted">
          No reconcile has run since this log was added — connect an estate or press “Reconcile this organisation now” on
          Onboarding, and the run lands here.
        </p>
      )}
      {reconciles.map((r) => (
        <div className="check-row" key={r.id}>
          <span className={`check-icon ${r.errors.length ? "fail" : r.finishedAt ? "ok" : ""}`}>
            {r.errors.length ? "✗" : r.finishedAt ? "✓" : "…"}
          </span>
          <span style={{ minWidth: "11rem" }}>{r.trigger}</span>
          <span className="muted" style={{ minWidth: "10rem" }}>{r.estateName ?? "—"}</span>
          <span className="muted">{new Date(r.startedAt).toLocaleString()}</span>
          <span className="muted">
            {r.reposWalked} repos · {r.issuesSeen} issues · {r.pullsSeen} PRs
          </span>
          {r.errors.length > 0 && <span className="muted" style={{ flex: 1 }}>{r.errors.join(" · ")}</span>}
        </div>
      ))}
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
      <OrchestratorSection orgId={orgId} settings={s} canEdit={canEdit} onSaved={() => void qc.invalidateQueries({ queryKey: ["org-settings", orgId] })} />
      <InsightSection orgId={orgId} settings={s} canEdit={canEdit} onSaved={() => void qc.invalidateQueries({ queryKey: ["org-settings", orgId] })} />
      <ProjectsSection orgId={orgId} canEdit={canEdit} />
      <SecretsSection orgId={orgId} settings={s} canEdit={canEdit} />
    </div>
  );
}

/** Group repos into projects so every view can be focused to one at a time. */
function ProjectsSection({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const data = useQuery({ queryKey: ["projects"], queryFn: () => api.get<ProjectsData>("/api/projects") });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["projects"] });

  const create = useMutation({
    mutationFn: () => api.post("/api/projects", { orgId, name: newName }),
    onSuccess: () => {
      setNewName("");
      refresh();
    },
  });
  const assign = useMutation({
    mutationFn: (v: { repoId: string; projectId: string | null }) =>
      api.post(`/api/repos/${v.repoId}/project`, { projectId: v.projectId }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (projectId: string) => api.del(`/api/projects/${projectId}`),
    onSuccess: refresh,
  });

  if (!data.data) return null;
  const projects = data.data.projects.filter((p) => p.orgId === orgId);
  const repos = [
    ...projects.flatMap((p) => p.repos.map((r) => ({ ...r, projectId: p.id }))),
    ...data.data.unassigned.filter((r) => r.orgId === orgId).map((r) => ({ ...r, projectId: null as string | null })),
  ].sort((a, b) => a.fullName.localeCompare(b.fullName));

  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <h3>Projects</h3>
      <p className="muted">
        Group the repos that ship together. Every view — My work, the board, Flow, Blocked — can then be focused to one
        project or one repo from the bar at the top of the page.
      </p>
      {repos.map((r) => (
        <div className="project-row" key={r.id}>
          <RepoChip fullName={r.fullName} />
          <span style={{ flex: 1 }} className="muted">
            {r.fullName}
          </span>
          <select
            value={r.projectId ?? ""}
            disabled={!canEdit}
            onChange={(e) => assign.mutate({ repoId: r.id, projectId: e.target.value || null })}
            style={{ width: "auto" }}
          >
            <option value="">— no project —</option>
            {projects.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      ))}
      {repos.length === 0 && <p className="muted">No repos connected in this org yet.</p>}

      {canEdit && (
        <>
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="new project name"
              style={{ width: "14rem" }}
            />
            <button disabled={!newName.trim() || create.isPending} onClick={() => create.mutate()}>
              Add project
            </button>
          </div>
          {create.isError && <div className="banner error" style={{ marginTop: "0.5rem" }}>{(create.error as ApiError).message}</div>}
          {projects.length > 0 && (
            <div className="row" style={{ marginTop: "0.5rem" }}>
              <span className="muted">Delete:</span>
              {projects.map((p) => (
                <button key={p.id} className="danger" disabled={remove.isPending} onClick={() => remove.mutate(p.id)}>
                  {p.name} ✕
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function OrchestratorSection({
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
  const save = useMutation({
    mutationFn: (engine: OrgSettings["orchestrator"]["engine"]) =>
      api.post<{ ok: boolean; engine: string; githubActionsEnabled: boolean }>(`/api/orgs/${orgId}/settings/orchestrator`, { engine }),
    onSuccess: onSaved,
  });
  const engine = s.orchestrator.engine;
  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <h3>Orchestrator</h3>
      <p className="muted">
        Which motor runs factory roles for this organisation. GitHub Actions is the zero-infra default. Software Factory
        is the Console&apos;s own orchestrator — when it is selected, GitHub Actions is not used (no Actions secrets, no
        workflow stubs). Re-run the stub-files step on each repo after switching so{" "}
        <code>.github/factory-orchestrator.json</code> matches.
      </p>
      <div className="engine-grid">
        <button
          type="button"
          className={`engine-card ${engine === "github-actions" ? "selected" : ""}`}
          disabled={!canEdit || save.isPending}
          onClick={() => engine !== "github-actions" && save.mutate("github-actions")}
        >
          <span className="engine-name">GitHub Actions</span>
          <p className="muted">Reusable workflow in each repo. Agent tokens are written as Actions secrets.</p>
        </button>
        <button
          type="button"
          className={`engine-card ${engine === "software-factory" ? "selected" : ""}`}
          disabled={!canEdit || save.isPending}
          onClick={() => engine !== "software-factory" && save.mutate("software-factory")}
        >
          <span className="engine-name">Software Factory</span>
          <p className="muted">LangGraph orchestrator. Agent tokens stay in the Console; Actions is not used.</p>
        </button>
      </div>
      {save.isError && <div className="banner error">{(save.error as ApiError).message}</div>}
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
  const [models, setModels] = useState<string[] | null>(null);
  const [manual, setManual] = useState(false);

  const loadModels = useMutation({
    mutationFn: () =>
      api.post<{ provider: string; models: string[] }>(`/api/orgs/${orgId}/settings/insight/models`, {
        provider,
        ...(apiKey ? { apiKey } : {}),
      }),
    onSuccess: (r) => {
      setModels(r.models);
      setManual(false);
      if (model && !r.models.includes(model)) setModel("");
    },
  });
  const save = useMutation({
    mutationFn: (body: { provider?: string; model?: string | null; apiKey?: string | null }) =>
      api.post(`/api/orgs/${orgId}/settings/insight`, body),
    onSuccess: () => {
      setApiKey("");
      onSaved();
    },
  });

  const pickProvider = (p: string) => {
    setProvider(p);
    setModels(null);
    setManual(false);
    setModel(p === s.insight.provider ? (s.insight.model ?? "") : "");
    loadModels.reset();
  };
  // A key to list with exists when one is typed, the stored key matches this
  // provider, or (anthropic only) the instance-wide key can stand in.
  const canLoad =
    canEdit &&
    Boolean(apiKey || (s.insight.hasKey && provider === s.insight.provider) || (provider === "anthropic" && s.insight.globalKeyConfigured));

  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <h3>Ask the Factory</h3>
      <p className="muted">
        Pick the provider, enter its <strong>API key</strong>, then load the models that key can use and choose one. For
        Anthropic, a Claude Code OAuth token authenticates the factory's agents, not API calls, and will be rejected.
        With no dedicated insight key, Ask the Factory uses the instance Anthropic key or the{" "}
        <code>ANTHROPIC_API_KEY</code> stored for factory runs.
      </p>
      <div className="row">
        <label style={{ minWidth: "4.5rem" }}>Provider</label>
        <select value={provider} onChange={(e) => pickProvider(e.target.value)} disabled={!canEdit} style={{ width: "auto" }}>
          {s.insight.providers.map((p) => (
            <option value={p} key={p}>
              {PROVIDER_LABELS[p] ?? p}
            </option>
          ))}
        </select>
      </div>
      <div className="row" style={{ marginTop: "0.4rem" }}>
        <label style={{ minWidth: "4.5rem" }}>API key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            s.insight.hasKey && provider === s.insight.provider
              ? "key is set — enter a new one to replace it"
              : (KEY_PLACEHOLDERS[provider] ?? "api key")
          }
          disabled={!canEdit}
          style={{ width: "18rem" }}
        />
        <button disabled={!canLoad || loadModels.isPending} onClick={() => loadModels.mutate()}>
          {loadModels.isPending ? "Loading…" : "Load models"}
        </button>
        <span className="badge">{s.insight.hasKey ? "key set" : s.insight.globalKeyConfigured ? "using instance key" : "no key"}</span>
      </div>
      {loadModels.isError && (
        <div className="banner error" style={{ marginTop: "0.5rem" }}>
          {(loadModels.error as ApiError).message}
        </div>
      )}
      {models && (
        <p className="muted" style={{ margin: "0.4rem 0 0" }}>
          Key accepted — {models.length} model{models.length === 1 ? "" : "s"} available.
        </p>
      )}
      <div className="row" style={{ marginTop: "0.4rem" }}>
        <label style={{ minWidth: "4.5rem" }}>Model</label>
        {models && !manual ? (
          <select
            value={models.includes(model) ? model : ""}
            onChange={(e) => (e.target.value === "__manual" ? setManual(true) : setModel(e.target.value))}
            disabled={!canEdit}
            style={{ width: "18rem" }}
          >
            <option value="">— select a model —</option>
            {models.map((m) => (
              <option value={m} key={m}>
                {m}
              </option>
            ))}
            <option value="__manual">Other (enter manually)…</option>
          </select>
        ) : (
          <input
            list={`models-${orgId}-${provider}`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={provider === "anthropic" ? `default: ${s.insight.defaultModel}` : "model id (required)"}
            disabled={!canEdit}
            style={{ width: "18rem" }}
          />
        )}
        <datalist id={`models-${orgId}-${provider}`}>
          {(MODEL_SUGGESTIONS[provider] ?? []).map((m) => (
            <option value={m} key={m} />
          ))}
        </datalist>
        {models && manual && (
          <button onClick={() => setManual(false)}>Back to list</button>
        )}
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
  const qc = useQueryClient();
  const [name, setName] = useState(s.allowedSecrets[1] ?? "CLAUDE_CODE_OAUTH_TOKEN");
  const [value, setValue] = useState("");
  const write = useMutation({
    mutationFn: (vars: { name: string; value: string }) =>
      api.post<SecretWriteResult>(`/api/orgs/${orgId}/settings/secrets`, vars),
    onSuccess: () => {
      setValue("");
      void qc.invalidateQueries({ queryKey: ["org-settings", orgId] });
    },
  });
  const actions = s.orchestrator.githubActionsEnabled;
  const retained = s.retainedSecrets.find((r) => r.name === name);

  return (
    <div>
      <h3>{actions ? "Agent token → GitHub secrets" : "Agent token"}</h3>
      <p className="muted">
        {actions ? (
          <>
            Writes the token to every connected repo&apos;s GitHub Actions secrets and keeps a copy in the Console for
            the Software Factory orchestrator. Per-repo control lives in Onboarding → step 2.
          </>
        ) : (
          <>
            GitHub Actions is disabled for this organisation, so this token is stored only in the Console for the
            Software Factory orchestrator — it is never written as an Actions secret.
          </>
        )}
      </p>
      {retained && (
        <p className="muted">
          {name} last stored {new Date(retained.updatedAt).toLocaleString()}
          {retained.updatedBy ? ` by ${retained.updatedBy}` : ""}.
        </p>
      )}
      <div className="row">
        <select value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} style={{ width: "auto" }}>
          {s.allowedSecrets.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
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
        <button className="primary" disabled={!canEdit || !value || write.isPending} onClick={() => write.mutate({ name, value })}>
          {write.isPending ? "Saving…" : actions ? "Write to all repos" : "Store in Console"}
        </button>
      </div>
      {write.isError && <div className="banner error" style={{ marginTop: "0.5rem" }}>{(write.error as ApiError).message}</div>}
      {write.data && (
        <div style={{ marginTop: "0.5rem" }}>
          {write.data.stored && <p className="muted">Stored in the Console.</p>}
          {write.data.githubActions === false && <p className="muted">Not written to GitHub Actions.</p>}
          {write.data.results.map((r) => (
            <div className="check-row" key={r.repo}>
              <span className={`check-icon ${r.ok ? "ok" : "fail"}`}>{r.ok ? "✓" : "✗"}</span>
              <span style={{ flex: 1 }}>{r.repo}</span>
              {r.error && <span className="muted">{r.error}</span>}
            </div>
          ))}
          {write.data.githubActions && write.data.results.length === 0 && <p className="muted">No connected repos in this org yet.</p>}
        </div>
      )}
    </div>
  );
}
