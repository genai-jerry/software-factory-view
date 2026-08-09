import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import type { EstateSummary, OnboardingState, ValidationResult } from "../types.js";

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
      {estates.data?.estates.length === 0 && (
        <div className="card">
          <p>
            No estates yet. <strong>Step 0</strong> happens on GitHub: install the Factory Console GitHub App on your org and
            select the repositories of your estate. The installation webhook creates the estate here automatically.
          </p>
        </div>
      )}
    </div>
  );
}

function EstateOnboarding({ estateId }: { estateId: string }) {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ["onboarding", estateId],
    queryFn: () => api.get<OnboardingState>(`/api/estates/${estateId}/onboarding`),
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
    return <span className={`badge ${s.status === "ok" ? "merge" : "blocked"}`}>{s.status}</span>;
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
          <strong>3 · OpenSpec</strong> — checked by validation; if missing run{" "}
          <code>npx -y @fission-ai/openspec@latest init --tools claude</code> and push
        </span>
      </div>

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
