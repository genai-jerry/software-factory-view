import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../api.js";
import type { Me } from "../types.js";

export interface McpToolView {
  name: string;
  title?: string;
  description?: string;
  readOnly: boolean;
  allowed: boolean;
}

export interface McpServerView {
  id: string;
  name: string;
  label: string;
  url: string;
  transport: "http" | "sse";
  headerNames: string[];
  tools: McpToolView[];
  useShape: boolean;
  useAsk: boolean;
  useBuild: boolean;
  enabled: boolean;
  checkedAt: string | null;
  checkError: string | null;
  updatedBy: string | null;
}

interface OrgTools {
  orgId: string;
  orgName: string;
  canEdit: boolean;
  servers: McpServerView[];
}

const PLACES = [
  { key: "useShape", label: "Shape", hint: "shaping ideas" },
  { key: "useAsk", label: "Ask", hint: "questions on a thread, Telegram discussions" },
  { key: "useBuild", label: "Builds", hint: "every factory role run, unattended" },
] as const;

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : "That did not go through. Try again.";
}

/**
 * Compass → Tools: MCP servers the factory's Claude can use. Connectors added
 * on claude.ai belong to that account and never reach the factory, so a
 * server is added here once, for the whole org.
 */
export function ToolsPage({ me }: { me: Me }) {
  return (
    <div>
      <h1>Tools</h1>
      <p className="muted">
        MCP servers the factory&apos;s Claude can use — in Shape, when answering questions, and in builds. Connectors you added on claude.ai belong to your
        claude.ai account and do not reach the factory; add the same server here by its URL. A change applies from the next message or run.
      </p>
      {me.orgs.map((o) => (
        <OrgToolsCard key={o.id} orgId={o.id} />
      ))}
      {me.orgs.length === 0 && <p className="muted">No orgs yet — connect an organisation first.</p>}
    </div>
  );
}

function OrgToolsCard({ orgId }: { orgId: string }) {
  const q = useQuery({ queryKey: ["org-tools", orgId], queryFn: () => api.get<OrgTools>(`/api/orgs/${orgId}/tools`) });
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.isError || !q.data) return <div className="banner error">{errorText(q.error)}</div>;
  const d = q.data;
  return (
    <section className="card">
      <h2>{d.orgName}</h2>
      {d.servers.length === 0 && <p className="muted">No tools yet. Claude can read the code and the issue threads, and builds can also search the web.</p>}
      {d.servers.map((s) => (
        <ServerBlock key={s.id} orgId={orgId} server={s} canEdit={d.canEdit} />
      ))}
      {d.canEdit ? <AddServer orgId={orgId} /> : <p className="muted">An org admin adds and changes tools.</p>}
    </section>
  );
}

function ServerBlock({ orgId, server: s, canEdit }: { orgId: string; server: McpServerView; canEdit: boolean }) {
  const qc = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const done = () => {
    setFailure(null);
    void qc.invalidateQueries({ queryKey: ["org-tools", orgId] });
  };
  const change = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/orgs/${orgId}/tools/${s.id}`, body),
    onSuccess: done,
    onError: (e) => setFailure(errorText(e)),
  });
  const test = useMutation({
    mutationFn: () => api.post(`/api/orgs/${orgId}/tools/${s.id}/test`),
    onSuccess: done,
    onError: (e) => setFailure(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/orgs/${orgId}/tools/${s.id}`),
    onSuccess: done,
    onError: (e) => setFailure(errorText(e)),
  });
  const busy = change.isPending || test.isPending || remove.isPending;
  const allowed = s.tools.filter((t) => t.allowed).length;

  return (
    <div className="tool-server" style={{ borderTop: "1px solid var(--border)", padding: "0.9rem 0" }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>
          {s.label} {!s.enabled && <span className="badge">off</span>}
        </h3>
        <span className="muted" style={{ wordBreak: "break-all" }}>
          {s.url}
          {s.transport === "sse" ? " · SSE" : ""}
          {s.headerNames.length > 0 ? ` · headers: ${s.headerNames.join(", ")}` : ""}
        </span>
      </div>
      {s.checkError && <p className="decision-failure">Last test failed: {s.checkError}</p>}

      <fieldset style={{ border: 0, padding: 0, margin: "0.6rem 0" }}>
        <legend className="muted">Used in</legend>
        <div className="row" style={{ flexWrap: "wrap", gap: "1rem" }}>
          {PLACES.map((p) => (
            <label key={p.key} title={p.hint}>
              <input type="checkbox" checked={s[p.key]} disabled={!canEdit || busy} onChange={(e) => change.mutate({ [p.key]: e.target.checked })} /> {p.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset style={{ border: 0, padding: 0, margin: "0.6rem 0" }}>
        <legend className="muted">
          Tools — {allowed} of {s.tools.length} allowed
        </legend>
        <ul className="facts" style={{ listStyle: "none", paddingLeft: 0 }}>
          {s.tools.map((t) => (
            <li key={t.name}>
              <label>
                <input
                  type="checkbox"
                  checked={t.allowed}
                  disabled={!canEdit || busy}
                  onChange={(e) => change.mutate({ tools: { [t.name]: e.target.checked } })}
                />{" "}
                <strong>{t.title ?? t.name}</strong> {t.readOnly ? <span className="badge">read-only</span> : <span className="badge blocked">can change things</span>}
              </label>
              {t.description && <div className="muted">{t.description}</div>}
            </li>
          ))}
        </ul>
        {s.useBuild && s.tools.some((t) => t.allowed && !t.readOnly) && (
          <p className="muted">Builds run unattended: a tool that can change things will be used without anyone approving each call.</p>
        )}
      </fieldset>

      {canEdit && (
        <div className="decision-actions">
          <button type="button" disabled={busy} onClick={() => test.mutate()}>
            {test.isPending ? "Testing…" : "Test again"}
          </button>
          <button type="button" disabled={busy} onClick={() => change.mutate({ enabled: !s.enabled })}>
            {s.enabled ? "Turn off" : "Turn on"}
          </button>
          {confirmRemove ? (
            <>
              <button type="button" className="danger" disabled={busy} onClick={() => remove.mutate()}>
                Yes, remove
              </button>
              <button type="button" onClick={() => setConfirmRemove(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirmRemove(true)}>
              Remove
            </button>
          )}
          {s.checkedAt && <span className="muted">Tested {new Date(s.checkedAt).toLocaleString()}</span>}
        </div>
      )}
      {failure && <p className="decision-failure">{failure}</p>}
    </div>
  );
}

function AddServer({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<"http" | "sse">("http");
  const [headers, setHeaders] = useState<Array<{ name: string; value: string }>>([]);
  const add = useMutation({
    mutationFn: () =>
      api.post<McpServerView>(`/api/orgs/${orgId}/tools`, {
        label: label.trim(),
        url: url.trim(),
        transport,
        headers: headers.filter((h) => h.name.trim() || h.value.trim()),
      }),
    onSuccess: () => {
      setLabel("");
      setUrl("");
      setTransport("http");
      setHeaders([]);
      void qc.invalidateQueries({ queryKey: ["org-tools", orgId] });
    },
  });
  const setHeader = (i: number, patch: Partial<{ name: string; value: string }>) => setHeaders((hs) => hs.map((h, j) => (j === i ? { ...h, ...patch } : h)));

  return (
    <form
      style={{ borderTop: "1px solid var(--border)", paddingTop: "0.9rem" }}
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <h3>Add an MCP server</h3>
      <p className="muted">
        Paste the server&apos;s URL — the same one you would give claude.ai, like <code>https://docs.sarvam.ai/_mcp/server</code>. Compass connects and lists its
        tools before saving. Read-only tools start allowed; tools that can change things start off.
      </p>
      <div style={{ display: "grid", gap: "0.5rem", maxWidth: "40rem" }}>
        <label>
          <span className="muted">Name</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Sarvam docs" style={{ width: "100%" }} />
        </label>
        <label>
          <span className="muted">URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" required inputMode="url" style={{ width: "100%" }} />
        </label>
        <label>
          <span className="muted">Transport</span>{" "}
          <select value={transport} onChange={(e) => setTransport(e.target.value as "http" | "sse")}>
            <option value="http">Streamable HTTP (most servers)</option>
            <option value="sse">SSE (older servers)</option>
          </select>
        </label>
        {headers.map((h, i) => (
          <div key={i} className="row" style={{ gap: "0.35rem", flexWrap: "wrap" }}>
            <input aria-label="Header name" value={h.name} onChange={(e) => setHeader(i, { name: e.target.value })} placeholder="Authorization" style={{ flex: "1 1 10rem" }} />
            <input
              aria-label="Header value"
              type="password"
              autoComplete="off"
              value={h.value}
              onChange={(e) => setHeader(i, { value: e.target.value })}
              placeholder="Bearer …"
              style={{ flex: "2 1 14rem", fontFamily: "var(--font-mono)" }}
            />
            <button type="button" onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <div className="decision-actions">
          <button type="button" onClick={() => setHeaders((hs) => [...hs, { name: "", value: "" }])}>
            Add a header (API key)
          </button>
          <button type="submit" className="primary" disabled={add.isPending || !url.trim()}>
            {add.isPending ? "Connecting…" : "Add server"}
          </button>
        </div>
        <p className="muted">Header values are stored sealed and are never shown again.</p>
      </div>
      {add.isError && <p className="decision-failure">{errorText(add.error)}</p>}
    </form>
  );
}
