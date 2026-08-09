import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api.js";
import type { Citation, QaData } from "../types.js";

const CANNED = [
  "Summarise this epic for a stakeholder.",
  "What are the riskiest parts of this design?",
  "Which WHEN/THEN scenarios lack a mapped test?",
  "What changed since the spec was approved?",
];

export function QaPanel({ epicId }: { epicId: string }) {
  const qc = useQueryClient();
  const qa = useQuery({ queryKey: ["qa", epicId], queryFn: () => api.get<QaData>(`/api/epics/${epicId}/qa`) });
  const [question, setQuestion] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: (q: string) =>
      api.post<{ conversationId: string }>(`/api/epics/${epicId}/qa`, { question: q, conversationId: conversationId ?? undefined }),
    onSuccess: (r) => {
      setConversationId(r.conversationId);
      setQuestion("");
      void qc.invalidateQueries({ queryKey: ["qa", epicId] });
    },
  });

  const conv = qa.data?.conversations.find((c) => c.id === conversationId) ?? qa.data?.conversations[0];

  return (
    <div className="card">
      <h3>Ask the Factory</h3>
      {qa.data && !qa.data.enabled && (
        <p className="muted">Insight service not configured — set ANTHROPIC_API_KEY on the API to enable Q&A.</p>
      )}
      {qa.data?.budget && (
        <p className="muted">
          org budget: {Math.round((qa.data.budget.used / Math.max(qa.data.budget.total, 1)) * 100)}% used
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
            {CANNED.map((c) => (
              <button key={c} className="chip" style={{ cursor: "pointer" }} disabled={ask.isPending} onClick={() => ask.mutate(c)}>
                {c}
              </button>
            ))}
          </div>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Grounded in this epic's artifacts, threads, PRs and runs — cited, private by default."
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
