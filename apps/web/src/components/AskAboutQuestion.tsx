import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ApiError, api } from "../api.js";

/**
 * Ask about the question the factory asked, before answering it: what it
 * means, what each option would do, which to take. The factory's own Claude
 * answers from the conversation and the code (POST /api/issues/:id/ask), and
 * the answer is shown here only — nothing posts to GitHub until the person
 * replies. Several questions can be asked in turn; the exchange stays on
 * the page until it is closed.
 */
export function AskAboutQuestion({ issueId }: { issueId: string }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Array<{ question: string; answer: string }>>([]);
  const id = useId();
  const ask = useMutation({
    mutationFn: (q: string) => api.post<{ answer: string }>(`/api/issues/${issueId}/ask`, { question: q }),
    onSuccess: (got, q) => {
      setTurns((t) => [...t, { question: q, answer: got.answer }]);
      setQuestion("");
    },
  });
  if (!open) {
    return (
      <p className="ask-about-offer">
        <button type="button" onClick={() => setOpen(true)} aria-expanded={false} aria-controls={id}>
          Ask about this
        </button>
        <span className="muted"> Not sure what is being asked, or what an option would mean? Ask before you answer.</span>
      </p>
    );
  }
  return (
    <div className="ask-about" id={id} role="group" aria-label="Ask about this question">
      {turns.map((t, i) => (
        <div key={i} className="ask-turn">
          <p className="ask-q">
            <b>You:</b> {t.question}
          </p>
          <div className="ask-answer">{t.answer}</div>
        </div>
      ))}
      <label htmlFor={`${id}-q`}>Ask about this question</label>
      <textarea
        id={`${id}-q`}
        rows={2}
        value={question}
        placeholder="What would option 1 change for the user? Which would you pick, and why?"
        onChange={(e) => setQuestion(e.target.value)}
        disabled={ask.isPending}
      />
      <div className="decision-actions">
        <button type="button" className="primary" disabled={!question.trim() || ask.isPending} onClick={() => ask.mutate(question.trim())}>
          {ask.isPending ? "Thinking…" : "Ask"}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      {ask.isError && <p className="decision-failure">{ask.error instanceof ApiError ? ask.error.message : "That did not go through. Try again."}</p>}
      <p className="muted">Answered by the factory from the conversation and the code. Nothing here posts to GitHub.</p>
    </div>
  );
}
