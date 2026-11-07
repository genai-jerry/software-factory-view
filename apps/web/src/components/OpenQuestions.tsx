import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import type { ThreadDetail } from "../types.js";
import { localTimesHtml } from "../lib/localTimes.js";

/**
 * The questions a gate is holding on, shown in full. A count alone ("1
 * question is still open") sends the reader hunting; the question is what
 * they need, with who asked it and the last thing said, and one control to
 * mark it answered so the gate stops asking.
 */
export function OpenQuestions({
  questions,
  ack,
  onAck,
  ackLabel,
}: {
  questions: Array<{ id: string; title: string; entryCount: number }>;
  ack: boolean;
  onAck: (v: boolean) => void;
  ackLabel: string;
}) {
  if (questions.length === 0) return null;
  return (
    <div className="open-questions">
      <p className="need">
        {questions.length === 1 ? "One question is still open:" : `${questions.length} questions are still open:`}
      </p>
      {questions.map((q) => (
        <OpenQuestion key={q.id} id={q.id} title={q.title} />
      ))}
      <label className="ack">
        <input type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} /> {ackLabel}
      </label>
    </div>
  );
}

function OpenQuestion({ id, title }: { id: string; title: string }) {
  const qc = useQueryClient();
  const thread = useQuery({ queryKey: ["thread", id], queryFn: () => api.get<ThreadDetail>(`/api/threads/${id}`), retry: false });
  const resolve = useMutation({
    mutationFn: () => api.post(`/api/threads/${id}/status`, { status: "resolved" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["gate"] });
      void qc.invalidateQueries({ queryKey: ["epic"] });
    },
  });
  // The last two entries carry the question and whatever answered it so far.
  const entries = (thread.data?.entries ?? []).slice(-2);
  return (
    <article className="open-question" aria-label={title}>
      <h3>{title}</h3>
      {thread.isLoading && <p className="muted">Loading…</p>}
      {thread.isError && <p className="muted">Could not load the question.</p>}
      {entries.map((e) => (
        <div className="oq-entry" key={e.id}>
          {e.author && <span className="muted">{e.author}: </span>}
          <div className="rel-body" dangerouslySetInnerHTML={{ __html: localTimesHtml(e.bodyHtml, e.createdAt ?? null) }} />
        </div>
      ))}
      <div className="decision-actions">
        <button type="button" className="secondary" onClick={() => resolve.mutate()} disabled={resolve.isPending || resolve.isSuccess}>
          {resolve.isSuccess ? "Marked as answered" : resolve.isPending ? "Marking…" : "Mark as answered"}
        </button>
      </div>
      {resolve.isError && <p className="decision-failure">That did not go through. Try again.</p>}
    </article>
  );
}
