import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import type { Citation, QaData, SetupStatus } from "../types.js";

/** One panel, two scopes (plan 07 §5): the epic workspace's context rail and
 * the peek drawer's issue scope share everything but corpus and prompts. */
export type QaScope = { kind: "epic"; id: string } | { kind: "issue"; id: string };

const CANNED: Record<QaScope["kind"], string[]> = {
  epic: [
    "Summarise this epic for a stakeholder.",
    "What are the riskiest parts of this design?",
    "Which WHEN/THEN scenarios lack a mapped test?",
    "What changed since the spec was approved?",
  ],
  issue: [
    "Summarise this issue and the discussion so far.",
    "What has the factory done, and what should a human do next?",
    "Why is this blocked?",
    "Who is expected to act next?",
  ],
};

export function QaPanel({ scope }: { scope: QaScope }) {
  const qc = useQueryClient();
  const base = scope.kind === "epic" ? `/api/epics/${scope.id}/qa` : `/api/issues/${scope.id}/qa`;
  const queryKey = ["qa", scope.kind, scope.id];
  const qa = useQuery({ queryKey, queryFn: () => api.get<QaData>(base) });
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api.get<SetupStatus>("/api/setup/status"), retry: false });
  const [question, setQuestion] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: (q: string) => api.post<{ conversationId: string }>(base, { question: q, conversationId: conversationId ?? undefined }),
    onSuccess: (r) => {
      setConversationId(r.conversationId);
      setQuestion("");
      void qc.invalidateQueries({ queryKey });
    },
  });

  const conv = qa.data?.conversations.find((c) => c.id === conversationId) ?? qa.data?.conversations[0];
  const enabled = Boolean(qa.data?.enabled);
  const placeholder =
    scope.kind === "epic"
      ? "Ask about this epic's artifacts, threads, PRs and runs — cited, private by default."
      : "Ask about this issue, its comments, and what the factory did — cited, private by default.";

  return (
    <div className="card">
      <h3>Ask the Factory</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Grounded in this {scope.kind === "epic" ? "epic" : "issue"} and the discussion around it.
      </p>
      {qa.isLoading && <p className="muted">Loading…</p>}
      {qa.isError && (
        <div className="banner error">Could not load Ask the Factory: {(qa.error as ApiError).message}</div>
      )}
      {qa.data && !enabled && (
        <div className="banner info">
          Not configured —{" "}
          {setup.data?.canEditApp ? (
            <>
              store a <strong>Claude token</strong> for the factory's agents (it is used first), or set an{" "}
              <strong>API key</strong> for any provider in <a href="/settings">Settings → Ask the Factory</a>.
            </>
          ) : (
            <>the GitHub App owner can set this org's model and API key in Settings</>
          )}
        </div>
      )}
      {qa.data?.budget && (
        <p className="muted">
          org budget: {Math.round((qa.data.budget.used / Math.max(qa.data.budget.total, 1)) * 100)}% used
          {enabled && qa.data.via === "claude" && " · Claude (subscription)"}
          {enabled && qa.data.via !== "claude" && qa.data.model && ` · ${qa.data.provider === "anthropic" || !qa.data.provider ? "" : `${qa.data.provider}/`}${qa.data.model}`}
        </p>
      )}
      {conv && (
        <div style={{ maxHeight: "22rem", overflowY: "auto", marginBottom: "0.5rem" }}>
          {conv.messages.map((m, i) => (
            <div className={`qa-message ${m.role}`} key={i}>
              <span className="bubble">{m.body}</span>
              {m.citations.length > 0 && (
                <div>
                  {m.citations.map((c: Citation, j: number) => (
                    <span className="chip" key={j} title={c.detail}>
                      {c.ref}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {qa.data && (
        <>
          {enabled && (
            <div style={{ marginBottom: "0.4rem" }}>
              {CANNED[scope.kind].map((c) => (
                <button key={c} className="chip" style={{ cursor: "pointer" }} disabled={ask.isPending} onClick={() => ask.mutate(c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={enabled ? placeholder : "Store a Claude token, or set an API key in Settings, to ask about this issue."}
            disabled={!enabled || ask.isPending}
            style={{ minHeight: "3.5rem" }}
          />
          {ask.isError && <div className="banner error">{(ask.error as ApiError).message}</div>}
          <div className="row" style={{ marginTop: "0.4rem" }}>
            <button className="primary" disabled={!enabled || !question.trim() || ask.isPending} onClick={() => ask.mutate(question)}>
              {ask.isPending ? "Thinking…" : "Ask"}
            </button>
            {conversationId && (
              <button
                onClick={() => {
                  setConversationId(null);
                }}
              >
                New conversation
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
