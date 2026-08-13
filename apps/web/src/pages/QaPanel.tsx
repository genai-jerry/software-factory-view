import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import type { Citation, QaData } from "../types.js";

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
    "Why is this blocked?",
    "What has to happen before this moves?",
    "Summarise the blocker's current state.",
    "Who is expected to act next?",
  ],
};

export function QaPanel({ scope }: { scope: QaScope }) {
  const qc = useQueryClient();
  const base = scope.kind === "epic" ? `/api/epics/${scope.id}/qa` : `/api/issues/${scope.id}/qa`;
  const queryKey = ["qa", scope.kind, scope.id];
  const qa = useQuery({ queryKey, queryFn: () => api.get<QaData>(base) });
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

  return (
    <div className="card">
      <h3>Ask the Factory</h3>
      {qa.data && !qa.data.enabled && (
        <p className="muted">
          Not configured — set this org's model and API key in <a href="/settings">Settings</a> (or ANTHROPIC_API_KEY on the API).
        </p>
      )}
      {qa.data?.budget && (
        <p className="muted">
          org budget: {Math.round((qa.data.budget.used / Math.max(qa.data.budget.total, 1)) * 100)}% used
          {qa.data.enabled && qa.data.model && ` · ${qa.data.provider === "anthropic" || !qa.data.provider ? "" : `${qa.data.provider}/`}${qa.data.model}`}
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
      {qa.data?.enabled && (
        <>
          <div style={{ marginBottom: "0.4rem" }}>
            {CANNED[scope.kind].map((c) => (
              <button key={c} className="chip" style={{ cursor: "pointer" }} disabled={ask.isPending} onClick={() => ask.mutate(c)}>
                {c}
              </button>
            ))}
          </div>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={
              scope.kind === "epic"
                ? "Grounded in this epic's artifacts, threads, PRs and runs — cited, private by default."
                : "Grounded in this issue, its blockers and dependents, and the epic's plan — cited, private by default."
            }
            style={{ minHeight: "3.5rem" }}
          />
          {ask.isError && <div className="banner error">{(ask.error as ApiError).message}</div>}
          <div className="row" style={{ marginTop: "0.4rem" }}>
            <button className="primary" disabled={!question.trim() || ask.isPending} onClick={() => ask.mutate(question)}>
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
