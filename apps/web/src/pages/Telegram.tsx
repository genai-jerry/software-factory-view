import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../api.js";

interface TelegramStatus {
  enabled: boolean;
  botUsername?: string;
  linked?: boolean;
  tgUsername?: string | null;
  paused?: boolean;
  linkedAt?: string | null;
}

/**
 * Connect Telegram (openspec telegram-decisions). Decisions waiting on you
 * arrive in a Telegram chat; you can decide there, or talk it through first.
 * Everyone can reach this page — it is about your own chat, not the org.
 */
export function TelegramPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["me-telegram"], queryFn: () => api.get<TelegramStatus>("/api/me/telegram"), refetchInterval: (q) => (q.state.data?.linked ? false : 5000) });
  const [failure, setFailure] = useState<string | null>(null);
  const onError = (e: unknown) => setFailure(e instanceof ApiError ? e.message : "That did not go through. Try again.");
  const refresh = () => qc.invalidateQueries({ queryKey: ["me-telegram"] });
  const connect = useMutation({
    mutationFn: () => api.post<{ url: string }>("/api/me/telegram/link"),
    onSuccess: (r) => {
      setFailure(null);
      window.open(r.url, "_blank", "noopener");
    },
    onError,
  });
  const pause = useMutation({ mutationFn: (paused: boolean) => api.post("/api/me/telegram/pause", { paused }), onSuccess: refresh, onError });
  const disconnect = useMutation({ mutationFn: () => api.del("/api/me/telegram"), onSuccess: refresh, onError });
  const s = status.data;

  return (
    <div>
      <h1>Telegram</h1>
      <p className="muted">
        Get the decisions that wait on you in a Telegram chat. Approve with a button, or reply to talk it through with Claude first. Nothing is posted on
        GitHub until you confirm, and it is posted as you.
      </p>
      {status.isLoading && <p className="muted">Loading…</p>}
      {s && !s.enabled && (
        <section className="card">
          <p>Telegram is not set up on this Compass yet. An admin sets the bot up once; then everyone can connect here.</p>
        </section>
      )}
      {s?.enabled && !s.linked && (
        <section className="card">
          <h2>Connect your chat</h2>
          <ol className="facts">
            <li>Tap Connect. Telegram opens a chat with @{s.botUsername}.</li>
            <li>Tap Start in Telegram. The chat is linked to your Compass sign-in.</li>
          </ol>
          <div className="decision-actions">
            <button type="button" className="primary" disabled={connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending ? "Opening…" : "Connect Telegram"}
            </button>
          </div>
          {connect.isSuccess && <p className="muted">Waiting for you to tap Start in Telegram. The link works once and expires in 15 minutes.</p>}
        </section>
      )}
      {s?.enabled && s.linked && (
        <section className="card">
          <h2>Connected</h2>
          <ul className="facts">
            <li>
              Chat: {s.tgUsername ? `@${s.tgUsername}` : "your Telegram chat"} with @{s.botUsername}
            </li>
            <li>{s.paused ? "Paused — no new decisions are sent." : "Decisions waiting on you are sent as they arrive."}</li>
            <li>Each decision is sent once. When it is decided anywhere, its message says so.</li>
            <li>A discussion that ends in a decision leaves its summary on the issue first, posted by Compass, then your comment.</li>
          </ul>
          <div className="decision-actions">
            <button type="button" disabled={pause.isPending} onClick={() => pause.mutate(!s.paused)}>
              {s.paused ? "Resume" : "Pause"}
            </button>
            <button type="button" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Disconnect
            </button>
          </div>
        </section>
      )}
      {failure && <p className="decision-failure">{failure}</p>}
    </div>
  );
}
