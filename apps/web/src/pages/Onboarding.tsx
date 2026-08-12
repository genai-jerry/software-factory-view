import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import { AppCredentialsForm } from "../components/AppCredentialsForm.js";
import type { EstateSummary, InstallationSummary, OnboardingState, SetupStatus, ValidationResult } from "../types.js";

export function OnboardingPage() {
  const estates = useQuery({ queryKey: ["estates"], queryFn: () => api.get<{ estates: EstateSummary[] }>("/api/estates") });
  const [estateId, setEstateId] = useState<string | null>(null);
  const chosen = estateId ?? estates.data?.estates[0]?.id ?? null;

  return (
    <div>
      <h1>Onboarding</h1>
      <p className="muted">
        Factory-enable a repository step by step. Every action lands in GitHub as labels, secrets and one PR — the Console keeps
        no state the factory needs. Steps are idempotent: re-running verifies instead of duplicating.
      </p>

      <ConnectEstate onConnected={() => estates.refetch()} />

      {estates.data && estates.data.estates.length > 1 && (
        <select value={chosen ?? ""} onChange={(e) => setEstateId(e.target.value)} style={{ width: "auto", marginBottom: "1rem" }}>
          {estates.data.estates.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      )}
      {chosen && <EstateOnboarding estateId={chosen} />}
    </div>
  );
}

/**
 * Step 0, in the app: pick a GitHub App installation you belong to and the
 * repositories that form the estate. No repo or org IDs in any config file,
 * and no dependency on an installation webhook arriving.
 *
 * Exported because the shell shows it on its own to a signed-in user who
 * belongs to nothing yet — connecting is what makes them a member, so it has
 * to be reachable from outside the membership-gated layout.
 */
export function ConnectEstate({ onConnected }: { onConnected: () => void }) {
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api.get<SetupStatus>("/api/setup/status") });
  const installations = useQuery({
    queryKey: ["installations"],
    queryFn: () => api.get<{ installations: InstallationSummary[] }>("/api/installations"),
    retry: false,
    enabled: setup.data?.configured === true,
  });
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [openFor, setOpenFor] = useState<number | null>(null);

  const connect = useMutation({
    mutationFn: (vars: { installationId: number; repoNodeIds: string[] }) => api.post("/api/estates", vars),
    onSuccess: () => {
      setOpenFor(null);
      setSelected({});
      onConnected();
      void installations.refetch();
    },
  });

  if (setup.data && !setup.data.configured) {
    return (
      <div className="card">
        <h3>Step 0 · Register the Console's GitHub App</h3>
        <p className="muted">This Console has no GitHub App yet — that is what lets it read your repos and sign you in.</p>
        {setup.data.credentialError && <div className="banner error">{setup.data.credentialError}</div>}
        <a href="/setup">
          <button className="primary">Create one on GitHub →</button>
        </a>
        <details style={{ marginTop: "0.75rem" }}>
          <summary className="muted">Already have a GitHub App? Enter its App ID and keys here</summary>
          <AppCredentialsForm status={setup.data} onSaved={() => setup.refetch()} />
        </details>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="spread">
        <h3 style={{ margin: 0 }}>Step 0 · Connect an estate</h3>
        <button onClick={() => installations.refetch()} disabled={installations.isFetching}>
          {installations.isFetching ? "Checking GitHub…" : "Refresh"}
        </button>
      </div>
      <p className="muted">
        Installations you can see on GitHub. Install the App on another org and refresh to add it here.
        {setup.data?.appSlug && (
          <>
            {" "}
            <a href={`https://github.com/apps/${setup.data.appSlug}/installations/new`} target="_blank" rel="noreferrer">
              Install on another org →
            </a>
          </>
        )}
      </p>
      {installations.isError && <div className="banner error">{(installations.error as ApiError).message}</div>}
      {installations.data?.installations.length === 0 && (
        <p className="muted">
          No installations found. Install the App on your organisation, then hit Refresh.
        </p>
      )}
      {installations.data?.installations.map((inst) => (
        <div key={inst.installationId} className="check-row" style={{ display: "block" }}>
          <div className="spread">
            <span>
              <strong>{inst.account}</strong> <span className="muted">({inst.accountType.toLowerCase()})</span>{" "}
              {inst.estateId ? (
                <span className="badge merge">connected · {inst.repos.filter((r) => r.connected).length} repos</span>
              ) : (
                <span className="badge">not connected</span>
              )}
            </span>
            <button onClick={() => setOpenFor(openFor === inst.installationId ? null : inst.installationId)}>
              {inst.estateId ? "Add repos" : "Connect"}
            </button>
          </div>
          {openFor === inst.installationId && (
            <div style={{ marginTop: "0.5rem" }}>
              {inst.repos.length === 0 && <p className="muted">No repositories visible in this installation.</p>}
              {inst.repos.map((r) => (
                <label key={r.nodeId} style={{ display: "block", padding: "0.15rem 0" }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto", marginRight: 6 }}
                    disabled={r.connected}
                    checked={r.connected || Boolean(selected[r.nodeId])}
                    onChange={(e) => setSelected({ ...selected, [r.nodeId]: e.target.checked })}
                  />
                  {r.fullName} {r.private && <span className="muted">(private)</span>}
                  {r.connected && <span className="badge merge">already connected</span>}
                </label>
              ))}
              {connect.isError && <div className="banner error">{(connect.error as ApiError).message}</div>}
              <div className="row" style={{ marginTop: "0.5rem" }}>
                <button
                  className="primary"
                  disabled={connect.isPending || Object.values(selected).every((v) => !v)}
                  onClick={() =>
                    connect.mutate({
                      installationId: inst.installationId,
                      repoNodeIds: Object.entries(selected)
                        .filter(([, v]) => v)
                        .map(([k]) => k),
                    })
                  }
                >
                  {connect.isPending ? "Connecting…" : "Connect selected & sync"}
                </button>
                <span className="muted">Connecting queues an immediate reconcile — no webhook needed.</span>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function EstateOnboarding({ estateId }: { estateId: string }) {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ["onboarding", estateId],
    queryFn: () => api.get<OnboardingState>(`/api/estates/${estateId}/onboarding`),
    // The OpenSpec step runs async in the worker — poll while any repo has one in flight.
    refetchInterval: (q) =>
      q.state.data?.repos.some((r) => ["pending", "running"].includes(r.steps["openspec"]?.status ?? "")) ? 3000 : false,
  });
  const reconcile = useMutation({
    mutationFn: () => api.post(`/api/estates/${estateId}/reconcile`),
  });

  return (
    <div>
      <div className="card">
        <div className="spread">
          <h3 style={{ margin: 0 }}>Adopt / resync</h3>
          <button onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
            {reconcile.isPending ? "Queued…" : reconcile.isSuccess ? "Reconcile queued ✓" : "Reconcile estate now"}
          </button>
        </div>
        <p className="muted">
          For repos factory-enabled before the Console existed: reconcile walks GitHub, imports issues, PRs, runs and gate
          assignments from <code>factory-approvers.json</code> — zero re-setup ("adopt existing install").
        </p>
      </div>
      {state.data?.repos.length === 0 && (
        <p className="muted">No repositories in this estate yet — connect some above.</p>
      )}
      {state.data?.repos.map((r) => <RepoOnboarding key={r.repoId} repo={r} onChanged={() => qc.invalidateQueries({ queryKey: ["onboarding", estateId] })} />)}
    </div>
  );
}

function RepoOnboarding({
  repo,
  onChanged,
}: {
  repo: OnboardingState["repos"][number];
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [secretName, setSecretName] = useState("ANTHROPIC_API_KEY");
  const [secretValue, setSecretValue] = useState("");
  const [validation, setValidation] = useState<ValidationResult | null>(
    (repo.steps["validate"]?.detail as { checks?: ValidationResult["checks"] } | undefined)?.checks
      ? { ok: repo.steps["validate"]!.status === "ok", checks: (repo.steps["validate"]!.detail as { checks: ValidationResult["checks"] }).checks }
      : null,
  );

  const run = useMutation({
    mutationFn: (path: string) => api.post<Record<string, unknown>>(path),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (e) => setError((e as ApiError).message),
  });

  const putSecret = useMutation({
    mutationFn: () => api.post(`/api/repos/${repo.repoId}/onboarding/secret`, { name: secretName, value: secretValue }),
    onSuccess: () => {
      setSecretValue("");
      setError(null);
      onChanged();
    },
    onError: (e) => setError((e as ApiError).message),
  });

  const validate = useMutation({
    mutationFn: () => api.post<ValidationResult>(`/api/repos/${repo.repoId}/onboarding/validate`),
    onSuccess: (r) => {
      setValidation(r);
      setError(null);
      onChanged();
    },
    onError: (e) => setError((e as ApiError).message),
  });

  const stepBadge = (step: string) => {
    const s = repo.steps[step];
    if (!s) return null;
    return <span className={`badge ${s.status === "ok" ? "merge" : s.status === "failed" ? "blocked" : ""}`}>{s.status}</span>;
  };

  return (
    <div className="card">
      <div className="spread">
        <h3 style={{ margin: 0 }}>
          {repo.fullName} {repo.factoryEnabled && <span className="badge merge">factory enabled</span>}
        </h3>
      </div>
      {error && <div className="banner error">{error}</div>}

      <div className="check-row">
        <span style={{ flex: 1 }}>
          <strong>1 · Labels</strong> — create the 14 <code>factory:*</code> labels (idempotent; fixes drift) {stepBadge("labels")}
        </span>
        <button onClick={() => run.mutate(`/api/repos/${repo.repoId}/onboarding/labels`)} disabled={run.isPending}>
          Run
        </button>
      </div>

      <div className="check-row" style={{ alignItems: "center" }}>
        <span style={{ flex: 1 }}>
          <strong>2 · Secret</strong> — written straight to GitHub Actions; the Console never stores it {stepBadge("secrets")}
        </span>
        <select value={secretName} onChange={(e) => setSecretName(e.target.value)} style={{ width: "auto" }}>
          <option>ANTHROPIC_API_KEY</option>
          <option>CLAUDE_CODE_OAUTH_TOKEN</option>
          <option>FACTORY_CROSS_REPO_TOKEN</option>
        </select>
        <input
          type="password"
          placeholder="secret value"
          value={secretValue}
          onChange={(e) => setSecretValue(e.target.value)}
          style={{ width: "14rem" }}
        />
        <button onClick={() => putSecret.mutate()} disabled={!secretValue || putSecret.isPending}>
          Write
        </button>
      </div>

      <div className="check-row">
        <span style={{ flex: 1 }}>
          <strong>3 · OpenSpec</strong> — the worker runs <code>openspec init --tools claude</code> and pushes the scaffold onto
          the enablement branch; no terminal needed {stepBadge("openspec")}
        </span>
        <button
          onClick={() => run.mutate(`/api/repos/${repo.repoId}/onboarding/openspec`)}
          disabled={run.isPending || ["pending", "running"].includes(repo.steps["openspec"]?.status ?? "")}
        >
          {["pending", "running"].includes(repo.steps["openspec"]?.status ?? "") ? "Installing…" : "Install"}
        </button>
      </div>
      {repo.steps["openspec"]?.status === "failed" && typeof repo.steps["openspec"]?.detail["error"] === "string" && (
        <p className="muted">✗ {repo.steps["openspec"]!.detail["error"] as string} — fix and re-run, or fall back to{" "}
          <code>npx -y @fission-ai/openspec@latest init --tools claude</code> locally
        </p>
      )}
      {typeof repo.steps["openspec"]?.detail["prUrl"] === "string" && (
        <p className="muted">
          → scaffold pushed to the{" "}
          <a href={repo.steps["openspec"]!.detail["prUrl"] as string} target="_blank" rel="noreferrer">enablement PR</a> (merge it
          on GitHub)
        </p>
      )}

      <div className="check-row">
        <span style={{ flex: 1 }}>
          <strong>4 · Profile</strong> — author <code>.factory/profile.json</code> (the one genuinely-yours file); validation
          checks schema keys
        </span>
      </div>

      <div className="check-row">
        <span style={{ flex: 1 }}>
          <strong>5 · Stub files PR</strong> — workflow stubs (permissions intact), models, approvers, issue template, settings.
          Merging the PR is the human act that enables the factory. {stepBadge("stubs")}
        </span>
        <button onClick={() => run.mutate(`/api/repos/${repo.repoId}/onboarding/stubs`)} disabled={run.isPending}>
          Open PR
        </button>
      </div>
      {typeof repo.steps["stubs"]?.detail["prUrl"] === "string" && (
        <p className="muted">
          → <a href={repo.steps["stubs"]!.detail["prUrl"] as string} target="_blank" rel="noreferrer">enablement PR</a> (merge it on
          GitHub)
        </p>
      )}

      <div className="check-row">
        <span style={{ flex: 1 }}>
          <strong>6 · Validation suite</strong> — nine checks, no writes on a healthy repo {stepBadge("validate")}
        </span>
        <button onClick={() => validate.mutate()} disabled={validate.isPending}>
          {validate.isPending ? "Checking…" : "Validate"}
        </button>
      </div>
      {validation && (
        <div style={{ marginTop: "0.4rem" }}>
          {validation.checks.map((c) => (
            <div className="check-row" key={c.check}>
              <span className={`check-icon ${c.ok === true ? "ok" : c.ok === false ? "fail" : "skip"}`}>
                {c.ok === true ? "✓" : c.ok === false ? "✗" : "–"}
              </span>
              <strong>{c.check}</strong>
              <span className="muted" style={{ flex: 1 }}>
                {c.detail}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="check-row">
        <span style={{ flex: 1 }}>
          <strong>7 · Canary</strong> — after the enablement PR merges, file a plain issue ("Add a FACTORY_CANARY.md with the
          run date") and watch it traverse the pipeline in this workspace; your first gate approval happens there.
        </span>
      </div>
    </div>
  );
}
