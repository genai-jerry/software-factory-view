import type { WebhookJob } from "../src/ingest.js";

/**
 * A synthetic but shape-accurate day of webhook deliveries: epic #16 travels
 * intake → spec-ready → G1 approved, grows a spec PR, a task sub-issue and a
 * workflow run. Payload shapes mirror GitHub's webhook documentation.
 */

const REPO = {
  node_id: "R_repo1",
  full_name: "acme/insurance-app-base",
  default_branch: "main",
  private: true,
};
const INSTALLATION = { id: 777 };

let deliveryCounter = 0;
function delivery(event: string, payload: Record<string, unknown>): WebhookJob {
  deliveryCounter += 1;
  return { deliveryGuid: `guid-${deliveryCounter}`, event, payload };
}

function issuePayload(action: string, issue: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { action, issue, repository: REPO, installation: INSTALLATION, sender: { login: "alice" }, ...extra };
}

const epicBase = {
  id: 16,
  node_id: "I_epic16",
  number: 16,
  title: "Payment reminders",
  state: "open",
  body: "Send payment reminders to customers before due dates.",
  user: { login: "jerry" },
  created_at: "2026-08-01T10:00:00Z",
  closed_at: null,
  html_url: "https://github.com/acme/insurance-app-base/issues/16",
};

const taskBase = {
  id: 21,
  node_id: "I_task21",
  number: 21,
  title: "task(backend): reminder scheduler",
  state: "open",
  body: "Parent: #16\n\nImplement the scheduler.",
  user: { login: "factory-bot" },
  created_at: "2026-08-01T12:00:00Z",
  closed_at: null,
  html_url: "https://github.com/acme/insurance-app-base/issues/21",
};

export function fixtureDeliveries(): WebhookJob[] {
  deliveryCounter = 0;
  return [
    delivery("installation", {
      action: "created",
      installation: { id: INSTALLATION.id, account: { login: "acme" } },
      repositories: [{ node_id: REPO.node_id, full_name: REPO.full_name }],
    }),
    // Epic opened, labelled intake.
    delivery(
      "issues",
      issuePayload("opened", { ...epicBase, labels: [], updated_at: "2026-08-01T10:00:00Z" }),
    ),
    delivery(
      "issues",
      issuePayload(
        "labeled",
        { ...epicBase, labels: [{ name: "factory:intake" }], updated_at: "2026-08-01T10:01:00Z" },
        { label: { name: "factory:intake" } },
      ),
    ),
    // Agent hand-off comment.
    delivery(
      "issue_comment",
      issuePayload("created", { ...epicBase, labels: [{ name: "factory:intake" }], updated_at: "2026-08-01T10:05:00Z" }, {
        comment: {
          id: 9001,
          node_id: "IC_c1",
          body: "Spec drafted, opening PR.\n\n<!-- factory-agent -->",
          user: { login: "github-actions[bot]" },
          created_at: "2026-08-01T10:05:00Z",
          updated_at: "2026-08-01T10:05:00Z",
          html_url: "https://github.com/acme/insurance-app-base/issues/16#issuecomment-9001",
        },
      }),
    ),
    // Spec PR opened.
    delivery("pull_request", {
      action: "opened",
      pull_request: {
        id: 501,
        node_id: "PR_spec16",
        number: 17,
        title: "Spec: payment reminders",
        state: "open",
        draft: false,
        merged_at: null,
        merge_commit_sha: null,
        head: { ref: "factory/16-spec", sha: "aaa111" },
        base: { ref: "main" },
        user: { login: "github-actions[bot]" },
        updated_at: "2026-08-01T10:06:00Z",
        html_url: "https://github.com/acme/insurance-app-base/pull/17",
      },
      repository: REPO,
      installation: INSTALLATION,
    }),
    // intake -> spec-ready.
    delivery(
      "issues",
      issuePayload(
        "unlabeled",
        { ...epicBase, labels: [{ name: "factory:spec-ready" }], updated_at: "2026-08-01T10:07:00Z" },
        { label: { name: "factory:intake" } },
      ),
    ),
    delivery(
      "issues",
      issuePayload(
        "labeled",
        { ...epicBase, labels: [{ name: "factory:spec-ready" }], updated_at: "2026-08-01T10:07:01Z" },
        { label: { name: "factory:spec-ready" } },
      ),
    ),
    // G1: the human approval comment (exact literal).
    delivery(
      "issue_comment",
      issuePayload("created", { ...epicBase, labels: [{ name: "factory:spec-ready" }], updated_at: "2026-08-02T09:00:00Z" }, {
        comment: {
          id: 9002,
          node_id: "IC_c2",
          body: "Approved",
          user: { login: "jerry" },
          created_at: "2026-08-02T09:00:00Z",
          updated_at: "2026-08-02T09:00:00Z",
          html_url: "https://github.com/acme/insurance-app-base/issues/16#issuecomment-9002",
        },
      }),
    ),
    delivery(
      "issues",
      issuePayload(
        "labeled",
        { ...epicBase, labels: [{ name: "factory:spec-approved" }], updated_at: "2026-08-02T09:01:00Z" },
        { label: { name: "factory:spec-approved" } },
      ),
    ),
    // Task sub-issue opened (parent via body), reaches ready.
    delivery("issues", issuePayload("opened", { ...taskBase, labels: [], updated_at: "2026-08-02T12:00:00Z" })),
    delivery(
      "issues",
      issuePayload(
        "labeled",
        { ...taskBase, labels: [{ name: "factory:ready" }], updated_at: "2026-08-02T12:01:00Z" },
        { label: { name: "factory:ready" } },
      ),
    ),
    // A console-threaded reply lands on the epic.
    delivery(
      "issue_comment",
      issuePayload("created", { ...epicBase, labels: [{ name: "factory:spec-approved" }], updated_at: "2026-08-02T13:00:00Z" }, {
        comment: {
          id: 9003,
          node_id: "IC_c3",
          body: "What about weekend due dates?\n\n<!-- console:thread=artifact/proposal -->",
          user: { login: "alice" },
          created_at: "2026-08-02T13:00:00Z",
          updated_at: "2026-08-02T13:00:00Z",
          html_url: "https://github.com/acme/insurance-app-base/issues/16#issuecomment-9003",
        },
      }),
    ),
    // Pipeline workflow run completes.
    delivery("workflow_run", {
      action: "completed",
      workflow_run: {
        id: 42001,
        node_id: "WR_1",
        name: "Factory pipeline",
        status: "completed",
        conclusion: "success",
        event: "issues",
        head_branch: "main",
        html_url: "https://github.com/acme/insurance-app-base/actions/runs/42001",
        run_started_at: "2026-08-01T10:02:00Z",
        created_at: "2026-08-01T10:02:00Z",
        updated_at: "2026-08-01T10:04:00Z",
      },
      repository: REPO,
      installation: INSTALLATION,
    }),
  ];
}
