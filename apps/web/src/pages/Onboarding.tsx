import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api.js";
import type { EstateSummary, InstallationSummary, OnboardingState, SetupStatus, ValidationResult } from "../types.js";

const INSTALL_SELECTION_KEY = "factory.installSelection";

type InstallSelection = { account: string; nodeIds: string[] };

function rememberInstallSelection(account: string, nodeIds: string[]): void {
  try {
    sessionStorage.setItem(INSTALL_SELECTION_KEY, JSON.stringify({ account, nodeIds } satisfies InstallSelection));
  } catch {
    // Private mode / quota — GitHub `state` is the fallback.
  }
}

function clearInstallSelection(): void {
  try {
    sessionStorage.removeItem(INSTALL_SELECTION_KEY);
  } catch {
    /* ignore */
  }
}

function readInstallSelection(): InstallSelection | null {
  try {
    const raw = sessionStorage.getItem(INSTALL_SELECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as InstallSelection;
    if (!parsed?.account || !Array.isArray(parsed.nodeIds)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function encodeInstallState(account: string, nodeIds: string[]): string {
  return `v1:${encodeURIComponent(account)}:${nodeIds.map(encodeURIComponent).join(",")}`;
}

function decodeInstallState(state: string | null): InstallSelection | null {
  if (!state?.startsWith("v1:")) return null;
  const rest = state.slice(3);
  const split = rest.indexOf(":");
  if (split < 0) return null;
  const account = decodeURIComponent(rest.slice(0, split));
  const nodeIds = rest
    .slice(split + 1)
    .split(",")
    .map((id) => decodeURIComponent(id))
    .filter(Boolean);
  return account ? { account, nodeIds } : null;
}

/**
 * GitHub only pre-selects repos on `/installations/new/permissions` when the
 * account is `suggested_target_id` (not `target_id`) and each repo is a
 * `repository_ids[]` query param. `target_id` lands on the right account but
 * defaults to "All repositories".
 */
function githubInstallHref(base: string | null, repositoryIds: number[], state?: string): string | null {
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return base;
  }
  const accountId = url.searchParams.get("suggested_target_id") ?? url.searchParams.get("target_id");
  const path = url.pathname.endsWith("/permissions") ? url.pathname : `${url.pathname.replace(/\/$/, "")}/permissions`;
  const parts: string[] = [];
  if (accountId) parts.push(`suggested_target_id=${encodeURIComponent(accountId)}`);
  for (const id of repositoryIds.slice(0, 100)) {
    if (id > 0) parts.push(`repository_ids[]=${id}`);
  }
  if (state) parts.push(`state=${encodeURIComponent(state)}`);
  return `${url.origin}${path}${parts.length ? `?${parts.join("&")}` : ""}`;
}

type OnboardingRepo = OnboardingState["repos"][number];

const SETUP_STEPS = ["labels", "secrets", "openspec", "stubs", "profile", "validate"] as const;

function isRepoSetup(repo: OnboardingRepo): boolean {
  return repo.factoryEnabled;
}

function stepProgress(repo: OnboardingRepo): { done: number; total: number } {
  const done = SETUP_STEPS.filter((s) => repo.steps[s]?.status === "ok").length;
  return { done, total: SETUP_STEPS.length };
}

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
      <ConnectEstate onConnected={() => estates.refetch()} title="Connect repositories" />
    </div>
  );
}

/**
 * Step 0, in the app: pick a GitHub App installation you belong to and the
 * repositories that form the organisation. No repo or org IDs in any config file,
 * and no dependency on an installation webhook arriving.
 *
 * Exported because the shell shows it on its own to a signed-in user who
 * belongs to nothing yet — connecting is what makes them a member, so it has
 * to be reachable from outside the membership-gated layout.
 */
export function ConnectEstate({
  onConnected,
  title = "Step 0 · Connect an organisation",
}: {
  onConnected: () => void;
  title?: string;
}) {
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api.get<SetupStatus>("/api/setup/status") });
  const [awaitingInstall, setAwaitingInstall] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return Boolean(params.get("installation_id") || params.get("setup_action") || readInstallSelection());
  });
  const installations = useQuery({
    queryKey: ["installations"],
    queryFn: () => api.get<{ installations: InstallationSummary[] }>("/api/installations"),
    retry: false,
    enabled: setup.data?.configured === true,
    refetchInterval: awaitingInstall ? 2500 : false,
  });
  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const remembered = readInstallSelection();
    if (!remembered) return {};
    const next: Record<string, boolean> = {};
    for (const id of remembered.nodeIds) next[id] = true;
    return next;
  });
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const autoConnecting = useRef(false);

  const connect = useMutation({
    mutationFn: (vars: { installationId: number; repoNodeIds: string[] }) => api.post("/api/estates", vars),
    onSuccess: () => {
      clearInstallSelection();
      setAwaitingInstall(false);
      setSelected({});
      onConnected();
      void installations.refetch();
    },
    onError: () => {
      autoConnecting.current = false;
    },
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromState = decodeInstallState(params.get("state"));
    if (fromState?.nodeIds.length) {
      rememberInstallSelection(fromState.account, fromState.nodeIds);
      setSelected((prev) => {
        const next = { ...prev };
        for (const id of fromState.nodeIds) next[id] = true;
        return next;
      });
      setAwaitingInstall(true);
    }
    const installationId = params.get("installation_id");
    if (!installationId) return;
    setAwaitingInstall(true);
    void installations.refetch();
    setHighlight(installationId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!highlight || !installations.data) return;
    const inst = installations.data.installations.find((i) => String(i.installationId) === highlight);
    if (!inst) return;
    const remembered = readInstallSelection();
    const wanted =
      remembered && remembered.account.toLowerCase() === inst.account.toLowerCase()
        ? new Set(remembered.nodeIds)
        : null;
    if (!wanted?.size) return;
    const next: Record<string, boolean> = {};
    for (const r of inst.repos) {
      if (!r.connected && r.nodeId && wanted.has(r.nodeId)) next[r.nodeId] = true;
    }
    if (Object.keys(next).length) setSelected((prev) => ({ ...next, ...prev }));
  }, [highlight, installations.data]);

  useEffect(() => {
    if (!awaitingInstall || autoConnecting.current || connect.isPending || !installations.data) return;
    const remembered = readInstallSelection();
    if (!remembered?.nodeIds.length) return;
    const inst = installations.data.installations.find(
      (i) => i.account.toLowerCase() === remembered.account.toLowerCase() && i.installationId != null,
    );
    if (!inst?.installationId) return;
    const nodeIds = remembered.nodeIds.filter((id) => inst.repos.some((r) => r.nodeId === id));
    if (!nodeIds.length) return;
    autoConnecting.current = true;
    connect.mutate({ installationId: inst.installationId, repoNodeIds: nodeIds });
  }, [awaitingInstall, installations.data, connect.isPending, connect.mutate]);

  if (setup.data && !setup.data.configured) {
    return (
      <div className="card">
        <h3>Connect an organisation</h3>
        <p className="muted">
          The factory GitHub App is not available yet, so installations cannot be listed. The GitHub App owner configures
          it in Settings after signing in, or pins it with <code>GITHUB_APP_*</code> secrets on the host.
        </p>
        {setup.data.credentialError && <div className="banner error">{setup.data.credentialError}</div>}
        {setup.data.canEditApp && (
          <a href="/settings">
            <button className="primary">Open Settings</button>
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="spread">
        <h3 style={{ margin: 0 }}>{title}</h3>
        <button onClick={() => installations.refetch()} disabled={installations.isFetching}>
          {installations.isFetching ? "Checking GitHub…" : "Refresh"}
        </button>
      </div>
      <p className="muted">
        Tick the repositories the factory should watch. If the App is not on that account yet, GitHub will ask you to
        confirm permissions with those repositories already selected, then return you here to continue the wizard.
        {setup.data?.appSlug && (
          <>
            {" "}
            <a href={`https://github.com/apps/${setup.data.appSlug}/installations/new`} target="_blank" rel="noreferrer">
              Install on another organisation →
            </a>
          </>
        )}
      </p>
      {awaitingInstall && (
        <div className="banner info">
          {connect.isPending
            ? "Connecting those repositories to the factory…"
            : "Confirm the install on GitHub. You will come back here automatically and the wizard will continue."}{" "}
          <button type="button" onClick={() => void installations.refetch()} disabled={installations.isFetching || connect.isPending}>
            {installations.isFetching ? "Checking GitHub…" : "I've confirmed — continue"}
          </button>
          <button
            type="button"
            onClick={() => {
              clearInstallSelection();
              setAwaitingInstall(false);
              autoConnecting.current = false;
            }}
            disabled={connect.isPending}
          >
            Cancel
          </button>
        </div>
      )}
      {connect.isError && awaitingInstall && (
        <div className="banner error">{(connect.error as ApiError).message}</div>
      )}
      {installations.isError && <div className="banner error">{(installations.error as ApiError).message}</div>}
      {installations.isFetching && !installations.data && <p className="muted">Loading repositories from GitHub…</p>}
      {installations.data && installations.data.installations.length === 0 && (
        <div className="banner info">
          No GitHub accounts or repositories were visible for this user yet.
          {setup.data?.appSlug ? (
            <>
              {" "}
              <a href={`https://github.com/apps/${setup.data.appSlug}/installations/new`} target="_blank" rel="noreferrer">
                Install the App on GitHub
              </a>{" "}
              (private repos are listed there), then come back and hit Refresh.
            </>
          ) : (
            <> Install the App on GitHub, then hit Refresh.</>
          )}
        </div>
      )}
      {installations.data &&
        (installations.data.installations.length > 1 ||
          installations.data.installations.reduce((n, i) => n + i.repos.length, 0) > 6) && (
          <input
            type="search"
            placeholder="Filter repositories…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ marginBottom: "0.75rem" }}
          />
        )}
      {installations.data?.installations.map((inst) => (
        <AccountRepos
          key={`${inst.installationId ?? "new"}:${inst.account}`}
          inst={inst}
          filter={filter}
          selected={selected}
          setSelected={setSelected}
          highlight={highlight !== null && String(inst.installationId) === highlight}
          awaitingInstall={awaitingInstall}
          onAwaitInstall={() => setAwaitingInstall(true)}
          connect={connect}
        />
      ))}
    </div>
  );
}

function AccountRepos({
  inst,
  filter,
  selected,
  setSelected,
  highlight,
  awaitingInstall,
  onAwaitInstall,
  connect,
}: {
  inst: InstallationSummary;
  filter: string;
  selected: Record<string, boolean>;
  setSelected: (next: Record<string, boolean>) => void;
  highlight: boolean;
  awaitingInstall: boolean;
  onAwaitInstall: () => void;
  connect: {
    isPending: boolean;
    isError: boolean;
    error: unknown;
    mutate: (vars: { installationId: number; repoNodeIds: string[] }) => void;
  };
}) {
  const q = filter.trim().toLowerCase();
  const visible = inst.repos.filter((r) => !q || r.fullName.toLowerCase().includes(q));
  if (q && visible.length === 0 && !inst.account.toLowerCase().includes(q)) return null;

  const installed = inst.installationId != null;
  const picked = inst.repos.filter((r) => !r.connected && r.inInstallation && Boolean(selected[r.nodeId]));
  const ungrantedPicked = installed
    ? inst.repos.filter((r) => !r.connected && !r.inInstallation && Boolean(selected[r.nodeId]))
    : [];
  const toGrant = inst.repos.filter((r) => !r.connected && Boolean(selected[r.nodeId]));
  const unconnectedVisible = visible.filter((r) => !r.connected && (!installed || r.inInstallation));
  const allVisiblePicked = unconnectedVisible.length > 0 && unconnectedVisible.every((r) => selected[r.nodeId]);
  const pickedIds = toGrant.map((r) => r.id).filter((id): id is number => typeof id === "number" && id > 0);
  const pickedNodeIds = toGrant.map((r) => r.nodeId).filter(Boolean);
  const href = githubInstallHref(
    inst.installUrl,
    pickedIds,
    pickedNodeIds.length ? encodeInstallState(inst.account, pickedNodeIds) : undefined,
  );

  const goInstall = () => {
    if (!href) return;
    rememberInstallSelection(inst.account, pickedNodeIds);
    onAwaitInstall();
    window.location.assign(href);
  };

  const toggleVisible = (on: boolean) => {
    const next = { ...selected };
    for (const r of visible) {
      if (r.connected || !r.nodeId) continue;
      if (installed && !r.inInstallation) continue;
      next[r.nodeId] = on;
    }
    setSelected(next);
  };

  return (
    <div className={`repo-account${highlight ? " highlight" : ""}`}>
      <div className="spread">
        <span>
          {inst.avatarUrl && <img src={inst.avatarUrl} alt="" width={18} height={18} className="repo-account-avatar" />}
          <strong>{inst.account}</strong> <span className="muted">({inst.accountType.toLowerCase()})</span>{" "}
          {inst.estateId ? (
            <span className="badge merge">connected · {inst.repos.filter((r) => r.connected).length} repos</span>
          ) : installed ? (
            <span className="badge">installed · pick repos</span>
          ) : (
            <span className="badge">not installed</span>
          )}
        </span>
        {unconnectedVisible.length > 0 && (
          <button type="button" onClick={() => toggleVisible(!allVisiblePicked)}>
            {allVisiblePicked ? "Clear" : "Select all"}
          </button>
        )}
      </div>
      {inst.repos.length === 0 && (
        <p className="muted">
          No repositories listed here yet. Private repositories appear on GitHub&apos;s next screen — install to pick
          them.
        </p>
      )}
      {visible.length > 0 && (
        <div className="repo-pick-list">
          {visible.map((r) => (
            <label key={r.nodeId || r.fullName} className="repo-pick">
              <input
                type="checkbox"
                style={{ width: "auto", marginRight: 6 }}
                disabled={r.connected}
                checked={r.connected || Boolean(selected[r.nodeId])}
                onChange={(e) => setSelected({ ...selected, [r.nodeId]: e.target.checked })}
              />
              {r.fullName} {r.private && <span className="muted">(private)</span>}
              {r.connected && <span className="badge merge">already connected</span>}
              {installed && !r.inInstallation && !r.connected && (
                <span className="badge">not on the App yet</span>
              )}
            </label>
          ))}
        </div>
      )}
      {connect.isError && installed && <div className="banner error">{(connect.error as ApiError).message}</div>}
      {installed && ungrantedPicked.length > 0 && picked.length === 0 && (
        <div className="banner stale">
          {ungrantedPicked.length === 1
            ? "That repository is not in the GitHub App installation yet. Add it on GitHub, then Refresh."
            : "Those repositories are not in the GitHub App installation yet. Add them on GitHub, then Refresh."}{" "}
          {inst.configureUrl && (
            <a href={inst.configureUrl} target="_blank" rel="noreferrer">
              Reinstall / change repositories on GitHub →
            </a>
          )}
        </div>
      )}
      <div className="row" style={{ marginTop: "0.5rem" }}>
        {installed ? (
          <>
            <button
              className="primary"
              disabled={connect.isPending || picked.length === 0}
              onClick={() =>
                connect.mutate({
                  installationId: inst.installationId as number,
                  repoNodeIds: picked.map((r) => r.nodeId),
                })
              }
            >
              {connect.isPending ? "Connecting…" : "Connect selected & sync"}
            </button>
            {inst.configureUrl && (
              <a href={inst.configureUrl} target="_blank" rel="noreferrer">
                Reinstall / change repositories on GitHub →
              </a>
            )}
            {href && (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  rememberInstallSelection(inst.account, pickedNodeIds);
                  onAwaitInstall();
                }}
              >
                Add repositories via install screen →
              </a>
            )}
            <span className="muted">Connecting queues an immediate reconcile — no webhook needed.</span>
          </>
        ) : href ? (
          <>
            <button type="button" className="primary" onClick={goInstall} disabled={awaitingInstall && connect.isPending}>
              {picked.length ? `Install factory on ${picked.length} selected` : "Install factory on this account"}
            </button>
            <span className="muted">
              {pickedIds.length
                ? "GitHub will ask you to confirm permissions, then return you here to continue."
                : "GitHub will ask you to confirm. Tick repositories above first to install on those only."}
            </span>
          </>
        ) : (
          <span className="muted">The App slug is not known yet, so an install link cannot be built.</span>
        )}
      </div>
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
  const onChanged = () => qc.invalidateQueries({ queryKey: ["onboarding", estateId] });
  const repos = state.data?.repos ?? [];
  const incomplete = repos.filter((r) => !isRepoSetup(r));
  const setup = repos.filter((r) => isRepoSetup(r));

  return (
    <div>
      {state.isLoading && <p className="muted">Loading repositories…</p>}
      {incomplete.length > 0 && (
        <>
          <h4 className="phase-head">Needs setup</h4>
          <div className="banner stale">
            {incomplete.length === 1
              ? "1 repository is not factory-enabled yet — finish the steps below."
              : `${incomplete.length} repositories are not factory-enabled yet — finish the steps below.`}
          </div>
        </>
      )}
      {incomplete.map((r) => (
        <RepoOnboarding key={r.repoId} repo={r} onChanged={onChanged} />
      ))}
      {setup.length > 0 && (
        <>
          <h4 className="phase-head">Setup</h4>
          {setup.map((r) => (
            <RepoOnboarding key={r.repoId} repo={r} onChanged={onChanged} />
          ))}
        </>
      )}
      {state.data && repos.length === 0 && (
        <p className="muted">No repositories in this organisation yet — connect some below.</p>
      )}
      <div className="card">
        <div className="spread">
          <h3 style={{ margin: 0 }}>Adopt / resync</h3>
          <button onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
            {reconcile.isPending ? "Queued…" : reconcile.isSuccess ? "Reconcile queued ✓" : "Reconcile this organisation now"}
          </button>
        </div>
        <p className="muted">
          For repos factory-enabled before the Console existed: reconcile walks GitHub, imports issues, PRs, runs and gate
          assignments from <code>factory-approvers.json</code> — zero re-setup ("adopt existing install").
        </p>
      </div>
    </div>
  );
}

function RepoOnboarding({
  repo,
  onChanged,
}: {
  repo: OnboardingRepo;
  onChanged: () => void;
}) {
  const setup = isRepoSetup(repo);
  const progress = stepProgress(repo);
  const [open, setOpen] = useState(!setup);
  const [error, setError] = useState<string | null>(null);
  const [secretName, setSecretName] = useState("CLAUDE_CODE_OAUTH_TOKEN");
  const [secretValue, setSecretValue] = useState("");
  const [validation, setValidation] = useState<ValidationResult | null>(
    (repo.steps["validate"]?.detail as { checks?: ValidationResult["checks"] } | undefined)?.checks
      ? { ok: repo.steps["validate"]!.status === "ok", checks: (repo.steps["validate"]!.detail as { checks: ValidationResult["checks"] }).checks }
      : null,
  );

  useEffect(() => {
    if (setup) setOpen(false);
  }, [setup]);

  const run = useMutation({
    mutationFn: (path: string) => api.post<Record<string, unknown>>(path),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (e) => setError((e as ApiError).message),
  });

  const putSecret = useMutation({
    mutationFn: (vars: { name: string; value: string }) => api.post(`/api/repos/${repo.repoId}/onboarding/secret`, vars),
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
          {repo.fullName}{" "}
          {setup ? (
            <span className="badge merge">Setup</span>
          ) : (
            <span className="badge task-start">
              {progress.done === 0 ? "Needs setup" : `${progress.done} of ${progress.total} steps`}
            </span>
          )}
        </h3>
        {setup && (
          <button type="button" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Correct setup"}
          </button>
        )}
      </div>
      {setup && !open && (
        <p className="muted" style={{ margin: "0.4rem 0 0" }}>
          Factory-enabled. Open Correct setup to fix secrets, stubs, or re-draft <code>.factory/profile.json</code>.
        </p>
      )}
      {error && open && <div className="banner error">{error}</div>}
      {open && (
        <>
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
          <strong>2 · Secret</strong> — written straight to GitHub Actions under the name you pick (Claude Code OAuth and
          the Anthropic API key are different credentials; the factory accepts either). The Console never stores it{" "}
          {stepBadge("secrets")}
          {typeof repo.steps["secrets"]?.detail["name"] === "string" && (
            <span className="muted"> · wrote {String(repo.steps["secrets"]!.detail["name"])}</span>
          )}
        </span>
        <select value={secretName} onChange={(e) => setSecretName(e.target.value)} style={{ width: "auto" }}>
          <option value="CLAUDE_CODE_OAUTH_TOKEN">CLAUDE_CODE_OAUTH_TOKEN</option>
          <option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY</option>
          <option value="FACTORY_CROSS_REPO_TOKEN">FACTORY_CROSS_REPO_TOKEN</option>
        </select>
        <input
          type="password"
          placeholder="secret value"
          value={secretValue}
          onChange={(e) => setSecretValue(e.target.value)}
          style={{ width: "14rem" }}
        />
        <button onClick={() => putSecret.mutate({ name: secretName, value: secretValue })} disabled={!secretValue || putSecret.isPending}>
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
          <strong>4 · Stub files PR</strong> — workflow stubs (permissions intact), models, approvers, issue template, settings.
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
          <strong>5 · Repo profile</strong> — <code>.factory/profile.json</code>, the stack facts every role treats as
          authoritative here. Re-run asks the <strong>Profiler</strong> to read the code again and open a correction PR if
          it disagrees — even when a profile is already merged. The Console never reads your source. {stepBadge("profile")}
        </span>
        <button
          onClick={() => run.mutate(`/api/repos/${repo.repoId}/onboarding/profile`)}
          disabled={run.isPending}
          title="Starts the Profiler in this repo's Actions. Re-run is how you correct a stale or wrong profile."
        >
          {repo.steps["profile"] || setup ? "Re-run" : "Draft it"}
        </button>
      </div>
      {typeof repo.steps["profile"]?.detail["issueUrl"] === "string" && (
        <p className="muted">
          → the run reports on{" "}
          <a href={repo.steps["profile"]!.detail["issueUrl"] as string} target="_blank" rel="noreferrer">
            its profile issue
          </a>
          . Re-run starts another Profiler pass; merge its PR to correct the profile.
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
        </>
      )}
    </div>
  );
}
