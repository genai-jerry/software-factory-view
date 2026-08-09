import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import type { BlockedIssue } from "../types.js";

export function BlockedPage() {
  const qc = useQueryClient();
  const blocked = useQuery({ queryKey: ["blocked"], queryFn: () => api.get<{ issues: BlockedIssue[] }>("/api/blocked") });
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [body, setBody] = useState("");

  const reply = useMutation({
    mutationFn: (vars: { id: string; body: string }) => api.post(`/api/issues/${vars.id}/reply`, { body: vars.body }),
    onSuccess: () => {
      setReplyFor(null);
      setBody("");
      void qc.invalidateQueries({ queryKey: ["blocked"] });
    },
  });

  return (
    <div>
      <h1>Blocked issues</h1>
      <p className="muted">
        A reply here is an ordinary GitHub comment under your identity — the factory's own comment trigger clears the blocked
        state and re-runs the stage with the whole thread in context.
      </p>
      <div className="card">
        {blocked.data?.issues.length === 0 && <p className="muted">Nothing is blocked.</p>}
        {blocked.data?.issues.map((i) => (
          <div key={i.id} className="attention-entry" style={{ display: "block" }}>
            <div className="spread">
              <span>
                <span className="badge blocked">blocked {i.ageDays}d</span>{" "}
                <Link to={`/epics/${i.epicId}`}>
                  #{i.number} {i.title}
                </Link>{" "}
                <span className="muted">{i.repo}</span>
                <a className="raw-link" href={i.htmlUrl} target="_blank" rel="noreferrer">
                  ≡ raw
                </a>
              </span>
              <button onClick={() => setReplyFor(replyFor === i.id ? null : i.id)}>Reply</button>
            </div>
            {replyFor === i.id && (
              <div style={{ marginTop: "0.5rem" }}>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Answer the agent's question…" />
                {reply.isError && <div className="banner error">{(reply.error as Error).message}</div>}
                <div className="row" style={{ marginTop: "0.4rem" }}>
                  <button
                    className="primary"
                    disabled={!body.trim() || reply.isPending}
                    onClick={() => reply.mutate({ id: i.id, body })}
                  >
                    {reply.isPending ? "Posting…" : "Post reply & unblock"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
