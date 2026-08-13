/** DTO shapes mirroring the API responses. */

export interface SetupStatus {
  configured: boolean;
  source: "database" | "environment" | null;
  appSlug: string | null;
  /** The registered App's numeric id, shown so an operator can confirm which App is in use. */
  appId: string | null;
  /** The OAuth client id — public by construction, so the edit form can prefill it. */
  clientId: string | null;
  /** Whether a webhook secret is stored (the secret itself never leaves the API). */
  hasWebhookSecret: boolean;
  /** Whether this browser could save a change to the App registration. */
  canEditApp: boolean;
  hasMasterKey: boolean;
  /** Set when a stored registration exists but cannot be decrypted. */
  credentialError: string | null;
  publicOrigin: string;
  insightEnabled: boolean;
  devLogin: boolean;
}

export interface InstallationSummary {
  installationId: number;
  account: string;
  accountType: string;
  avatarUrl: string | null;
  estateId: string | null;
  estateName: string | null;
  repos: Array<{ nodeId: string; fullName: string; defaultBranch: string; private: boolean; connected: boolean }>;
}

export interface Me {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  orgs: Array<{ id: string; name: string; role: string }>;
}

export interface EstateSummary {
  id: string;
  name: string;
  lastSyncedAt: string | null;
  stale: boolean;
  repos: Array<{
    id: string;
    fullName: string;
    defaultBranch: string;
    stagingBranch: string | null;
    factoryEnabled: boolean;
    lastSyncedAt: string | null;
  }>;
}

export interface AttentionEntry {
  kind: "gate" | "blocked" | "task-start" | "merge";
  /** 1 = agent halted on you · 2 = gate awaits you · 3 = task start awaits you · 4 = unowned broadcast */
  rank: 1 | 2 | 3 | 4;
  whyYou: string;
  epicId: string;
  issueId: string;
  title: string;
  repo: string;
  state: string | null;
  ageDays: number;
  /** For blocked entries: the agent's actual stuck question, when it left one. */
  question: string | null;
  link: string;
}

export type Phase = "specifying" | "planning" | "building" | "shipping" | "held";

export interface DepNode {
  id: string;
  number: number;
  title: string;
  state: string | null;
  open: boolean;
  htmlUrl: string;
}

export interface MineRow {
  issueId: string;
  epicId: string;
  number: number;
  title: string;
  repo: string;
  kind: string;
  state: string | null;
  phase: Phase;
  whyMine: "assigned" | "author";
  freshness: { lastMovedAt: string; quietDays: number };
  blocked: boolean;
  rollup?: TaskRollup;
}

export interface WaitingRow {
  issueId: string;
  number: number;
  title: string;
  repo: string;
  epicId: string;
  blocker: {
    issueId: string;
    number: number;
    title: string;
    state: string | null;
    phase: Phase;
    htmlUrl: string;
    assignees: string[];
    ageDays: number | null;
  };
}

export interface MyWork {
  needsYou: AttentionEntry[];
  mine: MineRow[];
  waitingOn: WaitingRow[];
}

export interface FlowData {
  estates: Array<{ id: string; name: string; milestones: FlowMilestone[] }>;
}

export interface FlowMilestone {
  title: string;
  trackerState: string | null;
  epics: FlowEpic[];
}

export interface FlowEpic {
  epicId: string;
  number: number;
  title: string;
  repo: string;
  state: string | null;
  phase: Phase;
  daysInState: number;
  rollup: TaskRollup;
  blockedCount: number;
  gate: { gate: string; label: string; approvers: string[] } | null;
  tasks: Array<{
    issueId: string;
    number: number;
    title: string;
    state: string | null;
    phase: Phase;
    open: boolean;
    assignees: string[];
    ageDays: number;
    blockedBy: number[];
  }>;
}

export interface IssuePeekData {
  issue: {
    id: string;
    number: number;
    title: string;
    repo: string;
    kind: string;
    state: string | null;
    phase: Phase;
    open: boolean;
    htmlUrl: string;
    assignees: string[];
    author: string | null;
  };
  sentence: string;
  nextMover: string | null;
  gate: { gate: string; label: string; approvers: string[] } | null;
  deps: { blockedBy: DepNode[]; blocks: DepNode[] };
  lastEvent: { at: string; detail: string; actor: string | null } | null;
  blocked: { since: string | null; question: string | null } | null;
  epicId: string;
}

export interface BoardCard {
  epicId: string;
  number: number;
  title: string;
  repo: string;
  estateId: string;
  state: string | null;
  open: boolean;
  daysInState: number;
  blocked: boolean;
  tasks: TaskRollup;
}

export interface TaskRollup {
  total: number;
  ready: number;
  inReview: number;
  inTest: number;
  done: number;
  blocked: number;
  /** Open tasks that have at least one open blocker. */
  waiting: number;
}

export interface EpicWorkspace {
  epic: {
    id: string;
    number: number;
    title: string;
    bodyHtml: string;
    state: string | null;
    open: boolean;
    author: string | null;
    htmlUrl: string;
    labels: string[];
  };
  repo: { id: string; fullName: string; defaultBranch: string };
  pipeline: string[];
  gate: { gate: string; label: string; amApprover: boolean; approvers: string[] } | null;
  tasks: Array<{
    id: string;
    number: number;
    title: string;
    state: string | null;
    open: boolean;
    htmlUrl: string;
    blockedBy: DepNode[];
    blocks: DepNode[];
  }>;
  rollup: TaskRollup;
  blockedSubIssues: Array<{ id: string; number: number; title: string; htmlUrl: string }>;
  change: { id: string; slug: string; status: string } | null;
  artifacts: Array<{ id: string; kind: string; path: string; latestSha: string | null; mergedSha: string | null; diverged: boolean }>;
  threads: Array<{ id: string; topicKind: string; topicRef: string; title: string; status: string; entryCount: number }>;
  freshness: { lastSyncedAt: string | null; stale: boolean };
}

export interface TimelineEvent {
  type: "state" | "run";
  at: string;
  detail: string;
  actor: string | null;
  link?: string;
}

export interface ArtifactView {
  path: string;
  ref: string;
  sha: string;
  markdown: string;
  html: string;
  otherSha: string | null;
}

export interface ThreadDetail {
  id: string;
  title: string;
  topicKind: string;
  topicRef: string;
  status: string;
  entries: Array<{
    id: string;
    source: string;
    author: string | null;
    bodyHtml: string;
    isAgent: boolean;
    isApproval: boolean;
    htmlUrl: string | null;
    createdAt: string;
  }>;
}

export interface GatePanelData {
  gate: string;
  label: string;
  state: string | null;
  amApprover: boolean;
  approvers: string[];
  commentApprovable: boolean;
  documentPrs: PrSummary[];
  releasePrs: PrSummary[];
  artifacts: Array<{ path: string; kind: string; sha: string | null; mergedSha: string | null; html: string | null }>;
  currentSha: string | null;
  changedSinceLastView: boolean;
  lastViewedSha: string | null;
  openQuestions: Array<{ id: string; title: string; topicRef: string; entryCount: number }>;
}

export interface PrSummary {
  id: string;
  number: number;
  title: string;
  kind: string;
  state: string;
  draft: boolean;
  ciStatus: string | null;
  headRef: string;
  baseRef: string;
  htmlUrl: string;
}

export interface Decision {
  id: string;
  title: string;
  context: string | null;
  options: string[];
  chosen: string | null;
  consequences: string | null;
  decidedBy: string | null;
  status: string;
  supersedesId: string | null;
  createdAt: string;
}

export interface BlockedIssue {
  id: string;
  number: number;
  title: string;
  repo: string;
  epicId: string;
  htmlUrl: string;
  ageDays: number;
}

export interface QaData {
  conversations: Array<{
    id: string;
    visibility: string;
    messages: Array<{ role: string; body: string; citations: Citation[]; createdAt: string }>;
  }>;
  enabled: boolean;
  /** The provider/model this org's questions run on (org override or instance default). */
  provider?: string;
  model?: string;
  budget: { used: number; total: number } | null;
}

export interface OrgSettings {
  id: string;
  name: string;
  role: string;
  insight: {
    provider: string;
    model: string | null;
    hasKey: boolean;
    defaultModel: string;
    globalKeyConfigured: boolean;
    providers: string[];
  };
  allowedSecrets: string[];
}

export interface ProjectsData {
  projects: Array<{ id: string; orgId: string; name: string; repos: Array<{ id: string; fullName: string }> }>;
  unassigned: Array<{ id: string; orgId: string; fullName: string }>;
}

export interface SecretWriteResult {
  name: string;
  results: Array<{ repo: string; ok: boolean; error?: string }>;
}

export interface Citation {
  kind: string;
  ref: string;
  detail?: string;
}

export interface OnboardingState {
  estateId: string;
  repos: Array<{
    repoId: string;
    fullName: string;
    factoryEnabled: boolean;
    steps: Record<string, { status: string; detail: Record<string, unknown>; updatedAt: string }>;
  }>;
}

export interface ValidationResult {
  ok: boolean;
  checks: Array<{ check: string; ok: boolean | null; detail: string }>;
}
