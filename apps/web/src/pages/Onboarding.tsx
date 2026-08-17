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

/**
 * What POST /onboarding/reset did. "direct" deleted the files from the default
 * branch; "pr" means branch protection forced a PR a human still has to merge;
 * "clean" means there was nothing left on GitHub and only Console state was
 * cleared.
 */
type ResetOutcome = {
  ok: boolean;
  mode: "direct" | "pr" | "clean";
  removed: string[];
  prUrl?: string;
  prNumber?: number;
  defaultBranch?: string;
};

/**
 * Reconstructed from the recorded reset step, not component state: the card
 * remounts when a reset moves the repo between the "Setup" and "Needs setup"
 * groups, and the outcome must also survive a page reload.
 */
function resetOutcomeFromSteps(repo: OnboardingRepo): ResetOutcome | null {
  const s = repo.steps["reset"];
  if (!s) return null;
  const d = s.detail as { mode?: unknown; removed?: unknown; prUrl?: unknown; prNumber?: unknown; branch?: unknown };
  if (d.mode !== "direct" && d.mode !== "pr" && d.mode !== "clean") return null; // legacy PR-only detail
  return {
    ok: true,
    mode: d.mode,
    removed: Array.isArray(d.removed) ? d.removed.filter((p): p is string => typeof p === "string") : [],
    prUrl: typeof d.prUrl === "string" ? d.prUrl : undefined,
    prNumber: typeof d.prNumber === "number" ? d.prNumber : undefined,
    defaultBranch: typeof d.branch === "string" ? d.branch : undefined,
  };
}

/**
 * What the webhook flow has recorded about the Profiler since the last ask
 * (worker: updateProfileStepFromRun / updateProfileStepFromPull). Everything
 * is optional because it accumulates: first the issue, then the run, then the
 * PR, then the merge.
 */
type ProfileProgress = {
  status: string;
  issueUrl?: string;
  run?: { htmlUrl: string; status: string; conclusion: string | null };
  prNumber?: number;
  prUrl?: string;
  prState?: "open" | "merged" | "closed";
  error?: string;
  mergedBy?: string;
};

function profileProgress(repo: OnboardingRepo): ProfileProgress | null {
  const s = repo.steps["profile"];
  if (!s) return null;
  const d = s.detail as Record<string, unknown>;
  const run = d["run"] as { htmlUrl?: unknown; status?: unknown; conclusion?: unknown } | undefined;
  return {
    status: s.status,
    issueUrl: typeof d["issueUrl"] === "string" ? d["issueUrl"] : undefined,
    run:
      run && typeof run.htmlUrl === "string"
        ? {
            htmlUrl: run.htmlUrl,
            status: typeof run.status === "string" ? run.status : "",
            conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
          }
        : undefined,
    prNumber: typeof d["prNumber"] === "number" ? d["prNumber"] : undefined,
    prUrl: typeof d["prUrl"] === "string" ? d["prUrl"] : undefined,
    prState: d["prState"] === "open" || d["prState"] === "merged" || d["prState"] === "closed" ? d["prState"] : undefined,
    error: typeof d["error"] === "string" ? d["error"] : undefined,
    mergedBy: typeof d["mergedBy"] === "string" ? d["mergedBy"] : undefined,
  };
}

/** True once a reset finished and no setup step has been run since. */
function isRepoClean(repo: OnboardingRepo): boolean {
  if (repo.steps["reset"]?.status !== "ok") return false;
  return !repo.factoryEnabled && SETUP_STEPS.every((s) => !repo.steps[s]);
}

const SETUP_STEPS = ["labels", "secrets", "claude-app", "openspec", "stubs", "profile", "validate"] as const;
const STEP_TITLES: Record<(typeof SETUP_STEPS)[number], string> = {
  labels: "Labels",
  secrets: "Secret",
  "claude-app": "Claude GitHub App",
  openspec: "OpenSpec",
  stubs: "Stub files PR",
  profile: "Repo profile",
  validate: "Validation suite",
};

function isRepoSetup(repo: OnboardingRepo): boolean {
  return repo.factoryEnabled;
}

function stepProgress(repo: OnboardingRepo): { done: number; total: number } {
  const done = SETUP_STEPS.filter((s) => repo.steps[s]?.status === "ok").length;
  return { done, total: SETUP_STEPS.length };
}

function collapsedSummary(repo: OnboardingRepo): string {
  if (isRepoClean(repo)) return "Factory removed — this repo is clean. Run the steps whenever you want to re-enable it.";
  const failed = SETUP_STEPS.find((s) => repo.steps[s]?.status === "failed");
  if (failed) {
    const err = repo.steps[failed]?.detail["error"];
    if (typeof err === "string" && err.trim()) return `${STEP_TITLES[failed]} failed — ${err}`;
    return `${STEP_TITLES[failed]} failed`;
  }
  const next = SETUP_STEPS.find((s) => repo.steps[s]?.status !== "ok");
  if (!next) return "All steps recorded — merge outstanding PRs or validate.";
  return repo.steps[next] ? `${STEP_TITLES[next]} in progress` : `Next: ${STEP_TITLES[next]}`;
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
    // Poll while anything is in flight elsewhere: the OpenSpec step runs async
    // in the worker, and the profile step runs in the repo's own Actions with
    // its progress arriving by webhook — both finish without another click here.
    refetchInterval: (q) =>
      q.state.data?.repos.some(
        (r) =>
          ["pending", "running"].includes(r.steps["openspec"]?.status ?? "") ||
          r.steps["profile"]?.status === "pending",
      )
        ? 3000
        : false,
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
      {incomplete.map((r, i) => (
        <RepoOnboarding key={r.repoId} repo={r} onChanged={onChanged} defaultOpen={i === 0} />
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
  defaultOpen,
}: {
  repo: OnboardingRepo;
  onChanged: () => void;
  defaultOpen?: boolean;
}) {
  const setup = isRepoSetup(repo);
  const progress = stepProgress(repo);
  const resetOutcome = resetOutcomeFromSteps(repo);
  const [open, setOpen] = useState(defaultOpen ?? !setup);
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

  const reset = useMutation({
    mutationFn: () => api.post<ResetOutcome>(`/api/repos/${repo.repoId}/onboarding/reset`),
    onSuccess: (r) => {
      setError(null);
      if (r.mode !== "pr") setValidation(null);
      setOpen(true);
      onChanged();
    },
    onError: (e) => {
      setError((e as ApiError).message);
      setOpen(true);
    },
  });

  const confirmReset = () => {
    if (
      !window.confirm(
        "Remove all factory files from this repo? They are deleted from the default branch right away (branch protection turns this into a PR you merge instead). Secrets, labels, and CLAUDE.md stay.",
      )
    ) {
      return;
    }
    reset.mutate();
  };

  const putSecret = useMutation({
    mutationFn: (vars: { name: string; value: string }) => api.post(`/api/repos/${repo.repoId}/onboarding/secret`, vars),
    onSuccess: () => {
      setSecretValue("");
      setError(null);
      onChanged();
    },
    onError: (e) => setError((e as ApiError).message),
  });

  const mergeProfilePr = useMutation({
    mutationFn: () => api.post<{ ok: boolean; sha: string }>(`/api/repos/${repo.repoId}/onboarding/profile/merge`),
    onSuccess: () => {
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
          ) : isRepoClean(repo) ? (
            <span className="badge merge">Clean — factory removed</span>
          ) : (
            <span className="badge task-start">
              {progress.done === 0 ? "Needs setup" : `${progress.done} of ${progress.total} steps`}
            </span>
          )}
        </h3>
        <span style={{ display: "flex", gap: "0.5rem" }}>
          <button type="button" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : setup ? "Correct setup" : "Show steps"}
          </button>
          <button type="button" className="danger" disabled={reset.isPending} onClick={confirmReset}>
            {reset.isPending ? "Resetting…" : "Reset factory…"}
          </button>
        </span>
      </div>
      {!open && (
        <p className="muted" style={{ margin: "0.4rem 0 0" }}>
          {setup
            ? <>Factory-enabled. Open Correct setup to fix secrets, stubs, or re-draft <code>.factory/profile.json</code>.</>
            : collapsedSummary(repo)}
        </p>
      )}
      {error && open && <div className="banner error">{error}</div>}
      {resetOutcome && (resetOutcome.mode === "pr" ? repo.steps["reset"]?.status === "pending" : isRepoClean(repo)) && (
        <ResetOutcomePanel outcome={resetOutcome} />
      )}
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

      <div className="check-row" style={{ alignItems: "center" }}>
        <span style={{ flex: 1 }}>
          <strong>3 · Claude GitHub App</strong> — agent runs exchange an OIDC token for this App's credentials at run
          time; without it on the repo every run fails with{" "}
          <em>"Claude Code is not installed on this repository"</em>. GitHub shows an App's installations only to its
          owner, so once it is installed (with this repo under its repository access), confirm here. {stepBadge("claude-app")}
          {typeof repo.steps["claude-app"]?.detail["confirmedBy"] === "string" && (
            <span className="muted"> · confirmed by {String(repo.steps["claude-app"]!.detail["confirmedBy"])}</span>
          )}
        </span>
        <a href="https://github.com/apps/claude" target="_blank" rel="noreferrer">
          Install on GitHub →
        </a>
        <button onClick={() => run.mutate(`/api/repos/${repo.repoId}/onboarding/claude-app`)} disabled={run.isPending}>
          {repo.steps["claude-app"]?.status === "ok" ? "Re-confirm" : "It's installed"}
        </button>
      </div>

      <div className="check-row">
        <span style={{ flex: 1 }}>
          <strong>4 · OpenSpec</strong> — the worker runs <code>openspec init --tools claude</code> and pushes the scaffold onto
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
          <strong>6 · Repo profile</strong> — <code>.factory/profile.json</code>, the stack facts every role treats as
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
      <ProfileStepFeedback
        progress={profileProgress(repo)}
        merging={mergeProfilePr.isPending}
        onMerge={() => mergeProfilePr.mutate()}
      />

      <div className="check-row">
        <span style={{ flex: 1 }}>
          <strong>7 · Validation suite</strong> — ten checks, no writes on a healthy repo {stepBadge("validate")}
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
          <strong>8 · Canary</strong> — after the enablement PR merges, file a plain issue ("Add a FACTORY_CANARY.md with the
          run date") and watch it traverse the pipeline in this workspace; your first gate approval happens there.
        </span>
      </div>

      <div className="check-row">
        <span style={{ flex: 1 }}>
          <strong>Reset</strong> — delete factory workflows, OpenSpec, and <code>.factory/profile.json</code> from the
          default branch and clear the recorded steps above (branch protection turns this into a PR you merge instead).
          Secrets, labels, and <code>CLAUDE.md</code> stay. {stepBadge("reset")}
        </span>
        <button type="button" className="danger" disabled={reset.isPending} onClick={confirmReset}>
          {reset.isPending ? "Resetting…" : "Reset factory…"}
        </button>
      </div>
        </>
      )}
    </div>
  );
}

/**
 * Live feedback under step 6, driven entirely by what the webhooks recorded:
 * the Profiler runs far away in the repo's own Actions, and without this the
 * operator pressed a button and stared at a "pending" chip with no way to know
 * whether it was running, dead, or waiting on them. One state at a time, most
 * decided first: failure, then the PR (the deliverable), then run progress.
 */
function ProfileStepFeedback({
  progress,
  merging,
  onMerge,
}: {
  progress: ProfileProgress | null;
  merging: boolean;
  onMerge: () => void;
}) {
  if (!progress) return null;
  const issueLink = progress.issueUrl ? (
    <a href={progress.issueUrl} target="_blank" rel="noreferrer">
      profile issue
    </a>
  ) : null;
  const runLink = progress.run ? (
    <a href={progress.run.htmlUrl} target="_blank" rel="noreferrer">
      Actions run
    </a>
  ) : null;

  if (progress.status === "failed") {
    return (
      <div className="banner error" style={{ marginTop: "0.4rem" }}>
        <strong>Profiler failed.</strong> {progress.error ?? "The step did not finish."}
        {runLink && <> Open the {runLink} for the log.</>}
        {issueLink && <> Any agent-side detail is on the {issueLink}.</>} Fix the cause, then press Re-run.
      </div>
    );
  }

  if (progress.prState === "open" && progress.prUrl) {
    return (
      <div className="banner info" style={{ marginTop: "0.4rem" }}>
        <strong>The Profiler opened a correction PR:</strong>{" "}
        <a href={progress.prUrl} target="_blank" rel="noreferrer">
          #{progress.prNumber}
        </a>
        . Its body is the evidence, field by field — review it, then merge; merging is where you agree to what the
        factory treats as true.{" "}
        <button className="primary" onClick={onMerge} disabled={merging} title="Squash-merges the PR on GitHub as you.">
          {merging ? "Merging…" : `Merge PR #${progress.prNumber}`}
        </button>
      </div>
    );
  }

  if (progress.prState === "closed" && progress.status !== "ok") {
    return (
      <div className="banner stale" style={{ marginTop: "0.4rem" }}>
        The Profiler's{" "}
        {progress.prUrl ? (
          <a href={progress.prUrl} target="_blank" rel="noreferrer">
            correction PR
          </a>
        ) : (
          "correction PR"
        )}{" "}
        was closed without merging, so the profile is unchanged. Press Re-run to have it draft a fresh one.
      </div>
    );
  }

  if (progress.status === "ok") {
    return (
      <p className="muted">
        ✓ Profile merged{progress.mergedBy ? ` by ${progress.mergedBy}` : ""}
        {progress.prUrl && (
          <>
            {" "}
            (
            <a href={progress.prUrl} target="_blank" rel="noreferrer">
              PR
            </a>
            )
          </>
        )}
        . Re-run any time to have the Profiler re-check it against the code.
      </p>
    );
  }

  // Still pending: distinguish "running", "ran and proposed nothing", and
  // "no run seen yet" — three states one chip could never carry.
  if (progress.run && progress.run.status !== "completed") {
    return (
      <p className="muted">
        → the Profiler is reading the repo in its {runLink}. Its findings land on the {issueLink ?? "profile issue"}, and
        this card updates when its PR appears.
      </p>
    );
  }
  if (progress.run && progress.run.conclusion === "success") {
    return (
      <p className="muted">
        → the {runLink} finished without opening a correction PR — the Profiler judged the current profile accurate (its
        note is on the {issueLink ?? "profile issue"}), or its PR is still arriving.
      </p>
    );
  }
  return (
    <p className="muted">
      → waiting for the Profiler's Actions run to start. Progress appears here as it happens
      {issueLink && <>; the run also reports on the {issueLink}</>}.
    </p>
  );
}

/**
 * Post-reset feedback: what actually happened, what was deliberately left in
 * place, and what to do next — so the operator is never staring at six stale
 * green badges wondering whether the reset took.
 */
function ResetOutcomePanel({ outcome }: { outcome: ResetOutcome }) {
  if (outcome.mode === "pr") {
    return (
      <div className="banner stale" style={{ marginTop: "0.6rem" }}>
        <strong>Reset needs a merge.</strong> Branch protection on the default branch stops the Console from deleting
        files directly, so it opened{" "}
        {outcome.prUrl ? (
          <a href={outcome.prUrl} target="_blank" rel="noreferrer">
            a reset PR{outcome.prNumber ? ` (#${outcome.prNumber})` : ""}
          </a>
        ) : (
          "a reset PR"
        )}{" "}
        deleting {outcome.removed.length} file{outcome.removed.length === 1 ? "" : "s"}.
        <ol style={{ margin: "0.4rem 0 0 1.2rem", padding: 0 }}>
          <li>Merge the reset PR on GitHub.</li>
          <li>
            Press <strong>Reset factory</strong> here once more — the Console will confirm the repo is clean and clear
            the recorded setup steps.
          </li>
        </ol>
      </div>
    );
  }

  return (
    <div className="banner success" style={{ marginTop: "0.6rem" }}>
      <strong>
        {outcome.mode === "clean"
          ? "This repo was already clean — no factory files found on GitHub."
          : `Factory removed — ${outcome.removed.length} file${outcome.removed.length === 1 ? "" : "s"} deleted from ${
              outcome.defaultBranch ?? "the default branch"
            }.`}
      </strong>{" "}
      The recorded setup steps were cleared and leftover <code>factory-console/*</code> branches pruned, so re-running
      setup starts fresh.
      {outcome.removed.length > 0 && (
        <details style={{ margin: "0.35rem 0 0" }}>
          <summary>Deleted files</summary>
          <ul style={{ margin: "0.25rem 0 0 1.2rem", padding: 0 }}>
            {outcome.removed.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p style={{ margin: "0.4rem 0 0.2rem" }}>
        <strong>Still in place</strong> (harmless, and reusable if you re-enable): Actions secrets, the{" "}
        <code>factory:*</code> labels, and <code>CLAUDE.md</code>.
      </p>
      <p style={{ margin: "0 0 0.2rem" }}>
        <strong>Next steps:</strong>
      </p>
      <ul style={{ margin: "0 0 0 1.2rem", padding: 0 }}>
        <li>
          <strong>To re-enable the factory:</strong> run the steps above top to bottom — Labels and Secret will verify
          instantly, then merge the fresh enablement PR from step 5.
        </li>
        <li>
          <strong>To leave it off:</strong> nothing else is required. Optionally delete the Actions secret and{" "}
          <code>factory:*</code> labels on GitHub, close the open <em>Factory: repo profile</em> issue, and remove the
          repo from the GitHub App installation.
        </li>
      </ul>
    </div>
  );
}
