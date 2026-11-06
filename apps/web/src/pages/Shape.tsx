import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { Diagram } from "../components/Diagram.js";
import { RepoChip } from "../components/RepoChip.js";
import { Sheet } from "../components/Sheet.js";
import { useFocus } from "../lib/filter.js";
import { splitOpenSpec } from "../lib/openspec.js";
import type { BoardCard, ShapeConversation, ShapeConversationSummary, ShapeMessage } from "../types.js";
import { localTimesHtml } from "../lib/localTimes.js";

/**
 * Shape — a chat that turns an idea into work. A person picks the repository
 * the chat may read, talks in plain words with screenshots attached, asks for
 * a page or a change to be shown (the answer carries an HTML mock rendered in
 * a sandboxed preview), then turns the conversation into a requirement and
 * the requirement into work — the same door Add work uses.
 */

interface Target {
  id: string;
  fullName: string;
  projectId: string | null;
  projectName: string | null;
  factoryEnabled: boolean;
}

/** An image the person picked, held locally until the message is sent. */
interface Pending {
  key: string;
  name: string;
  mime: string;
  dataUrl: string;
}

const SUGGESTIONS = [
  "What does the leads page show today?",
  "Visualise a day-wise calling panel beside the monthly table",
  "Where would a new CRM status field be stored?",
];

const EPIC_SUGGESTIONS = ["What is left before this ships?", "Which tests are still to run?", "Visualise the change this epic makes"];

/** Open epics a conversation can be about: the requirement issues on the board, not their tasks. */
function openEpics(cards: BoardCard[]): BoardCard[] {
  return cards
    .filter((c) => c.open && !/^(?:task|test|bug)\(\d+\)/i.test(c.title) && c.title !== "Factory: repo profile" && c.state !== "factory:deployed")
    .sort((a, b) => a.title.localeCompare(b.title));
}

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function shortRepo(fullName: string): string {
  return fullName.split("/").pop() ?? fullName;
}

/** The chip for an idea that spans a project: every repository, not one. */
function ProjectChip({ name }: { name: string }) {
  return (
    <span className="repo-chip" title={`Every repository in ${name}`}>
      <span className="repo-dot repo-dot-all" />
      All of {name}
    </span>
  );
}

/**
 * What the "Which product" select offers: each project's repositories, led
 * by "All of <project>" when the project has more than one, so an idea can
 * span them. Repositories outside a project come last.
 */
function targetOptions(enabled: Target[]): Array<{ value: string; label: string }> {
  const byProject = new Map<string, { name: string; repos: Target[] }>();
  const loose: Target[] = [];
  for (const t of enabled) {
    if (!t.projectId) loose.push(t);
    else (byProject.get(t.projectId) ?? byProject.set(t.projectId, { name: t.projectName ?? "the project", repos: [] }).get(t.projectId)!).repos.push(t);
  }
  const out: Array<{ value: string; label: string }> = [];
  for (const [projectId, g] of byProject) {
    if (g.repos.length > 1) out.push({ value: `project:${projectId}`, label: `All of ${g.name}` });
    for (const t of g.repos) out.push({ value: t.id, label: shortRepo(t.fullName) });
  }
  for (const t of loose) out.push({ value: t.id, label: shortRepo(t.fullName) });
  return out;
}

function failureText(e: unknown): string {
  return e instanceof ApiError ? e.message : "That did not go through. Try again.";
}

export function ShapePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["shape"], queryFn: () => api.get<{ conversations: ShapeConversationSummary[] }>("/api/shape") });
  const targets = useQuery({ queryKey: ["work-targets"], queryFn: () => api.get<{ targets: Target[] }>("/api/work/targets") });
  const focus = useFocus();
  const board = useQuery({ queryKey: ["board", focus.key], queryFn: () => api.get<{ cards: BoardCard[] }>(`/api/board${focus.qs}`) });
  const enabled = (targets.data?.targets ?? []).filter((t) => t.factoryEnabled);
  const [repoId, setRepoId] = useState("");
  const [start, setStart] = useState<"fresh" | "epic">("fresh");
  const [epicId, setEpicId] = useState("");
  const options = targetOptions(enabled);
  // The focus filter picks the default: its repo, else "All of" its project when that is on offer, else the first choice.
  const chosen =
    repoId ||
    (enabled.some((t) => t.id === focus.repo) ? focus.repo : "") ||
    (options.some((o) => o.value === `project:${focus.project}`) ? `project:${focus.project}` : "") ||
    options[0]?.value ||
    "";
  const spanning = chosen.startsWith("project:");
  const epics = openEpics(board.data?.cards ?? []);
  const chosenEpic = epicId || epics[0]?.epicId || "";

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>("/api/shape", start === "epic" ? { epicId: chosenEpic } : spanning ? { projectId: chosen.slice("project:".length) } : { repoId: chosen }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["shape"] });
      navigate(`/shape/${r.id}`);
    },
  });
  const canStart = start === "epic" ? Boolean(chosenEpic) : Boolean(chosen);

  const conversations = list.data?.conversations ?? [];

  return (
    <div className="shape">
      <aside className="shape-list card" aria-label="Your ideas">
        <h2>Shape an idea</h2>
        <p className="muted">Talk it through with the factory. It reads the code, draws the screen, then writes the requirement.</p>
        <div className="shape-start-pick" role="radiogroup" aria-label="How to start">
          <label className={start === "fresh" ? "on" : ""}>
            <input type="radio" name="shape-start" checked={start === "fresh"} onChange={() => setStart("fresh")} /> Start fresh
          </label>
          <label className={start === "epic" ? "on" : ""}>
            <input type="radio" name="shape-start" checked={start === "epic"} onChange={() => setStart("epic")} /> About an epic
          </label>
        </div>
        {start === "fresh" ? (
          <>
            <label htmlFor="shape-repo" className="muted">
              Which product
            </label>
            {targets.isLoading ? (
              <p className="muted">Reading the projects…</p>
            ) : enabled.length === 0 ? (
              <p className="muted">
                No repository is set up for the factory yet. <Link to="/onboarding">Finish setup on Onboarding</Link>.
              </p>
            ) : (
              <select id="shape-repo" value={chosen} onChange={(e) => setRepoId(e.target.value)}>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            <p className="muted shape-hint">
              {spanning ? "The idea can span every repository in the project. You pick where the work opens." : "Runs against the latest main of every repository in the project."}
            </p>
          </>
        ) : (
          <>
            <label htmlFor="shape-epic" className="muted">
              Which epic
            </label>
            {board.isLoading ? (
              <p className="muted">Reading the work…</p>
            ) : epics.length === 0 ? (
              <p className="muted">No epic is in progress here. Start fresh instead.</p>
            ) : (
              <select id="shape-epic" value={chosenEpic} onChange={(e) => setEpicId(e.target.value)}>
                {epics.map((c) => (
                  <option key={c.epicId} value={c.epicId}>
                    {c.title}
                  </option>
                ))}
              </select>
            )}
            <p className="muted shape-hint">Reads the epic's branch and its plan, design and tests.</p>
          </>
        )}
        <button type="button" className="primary" disabled={!canStart || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Opening…" : "New idea"}
        </button>
        {create.isError && <p className="decision-failure">{failureText(create.error)}</p>}
        {list.isLoading ? (
          <p className="muted">Loading…</p>
        ) : conversations.length === 0 ? (
          <p className="muted shape-empty">Nothing shaped yet. Start with a question or a screenshot, and the factory answers from the code.</p>
        ) : (
          <ul className="shape-convs">
            {conversations.map((c) => (
              <li key={c.id} className={c.id === id ? "current" : ""}>
                <Link to={`/shape/${c.id}`}>
                  <span className="shape-conv-title">{c.title}</span>
                  {c.epic && <span className="shape-conv-epic muted">About {c.epic.title}</span>}
                  <span className="shape-conv-meta">
                    {c.scope === "project" && !c.epic ? <ProjectChip name={c.projectName ?? "the project"} /> : <RepoChip fullName={c.repo} />}
                    {c.issueUrl ? <span className="stage-chip done">opened</span> : c.hasSpec ? <span className="stage-chip decide">spec</span> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <main className="shape-main">
        {id ? (
          <Conversation id={id} key={id} />
        ) : (
          <section className="card shape-intro">
            <h1>Shape an idea</h1>
            <p>
              Pick a product on the left and press <strong>New idea</strong>. Ask what a page does today, paste a screenshot, or ask for a new screen to be drawn. When the idea is clear, the factory writes the requirement and you open it as work.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}

function Conversation({ id }: { id: string }) {
  const qc = useQueryClient();
  // Answers and the requirement are written in the background: while one is
  // pending the page asks again every few seconds, and stops when it lands.
  const q = useQuery({
    queryKey: ["shape", id],
    queryFn: () => api.get<ShapeConversation>(`/api/shape/${id}`),
    retry: false,
    refetchInterval: (query) => (busy(query.state.data) ? 3_000 : false),
  });
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [showSpec, setShowSpec] = useState(false);
  const [opening, setOpening] = useState(false);
  const [opened, setOpened] = useState<{ title: string; htmlUrl: string; epicId?: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["shape", id] });
    void qc.invalidateQueries({ queryKey: ["shape"] });
  };

  const send = useMutation({
    mutationFn: async ({ body, files }: { body: string; files: Pending[] }) => {
      const attachmentIds: string[] = [];
      for (const f of files) {
        const dataB64 = f.dataUrl.slice(f.dataUrl.indexOf(",") + 1);
        const up = await api.post<{ id: string }>(`/api/shape/${id}/attachments`, { name: f.name, mime: f.mime, dataB64 });
        attachmentIds.push(up.id);
      }
      return api.post<{ message: ShapeMessage; conversation: { title: string } }>(`/api/shape/${id}/messages`, { text: body, attachmentIds });
    },
    onSuccess: () => {
      setText("");
      setPending([]);
      refresh();
    },
  });

  const retry = useMutation({
    mutationFn: (messageId: string) => api.post(`/api/shape/${id}/messages/${messageId}/retry`, {}),
    onSuccess: refresh,
  });

  const writeSpec = useMutation({
    mutationFn: () => api.post<{ specStatus: string }>(`/api/shape/${id}/spec`),
    onSuccess: () => {
      setShowSpec(true);
      refresh();
    },
  });

  const count = q.data?.messages?.length ?? 0;
  const answering = (q.data?.messages ?? []).some((m) => m.status === "pending");
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [count, send.isPending, answering]);

  const addFiles = async (files: FileList | File[]) => {
    const picked: Pending[] = [];
    for (const f of Array.from(files)) {
      if (!IMAGE_MIMES.has(f.type)) continue;
      picked.push({ key: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`, name: f.name || "image.png", mime: f.type, dataUrl: await readAsDataUrl(f) });
    }
    if (picked.length) setPending((p) => [...p, ...picked].slice(0, 6));
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files ?? []).filter((f) => IMAGE_MIMES.has(f.type));
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };
  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      void addFiles(e.dataTransfer.files);
    }
  };
  const submit = () => {
    const body = text.trim();
    if (!body && pending.length === 0) return;
    if (send.isPending || answering) return;
    send.mutate({ body: body || "What do you see in this screenshot?", files: pending });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  if (q.isError) {
    const err = q.error as ApiError;
    return <div className="banner error">{err.status === 404 ? "This idea is not yours, or it was removed." : err.message}</div>;
  }
  if (!q.data?.conversation) return <p className="muted">Loading…</p>;
  const conversation = q.data.conversation;
  const messages = q.data.messages ?? [];
  // Once the issue is projected, the idea is about its epic and the chat goes on
  // (on the epic's branch). Until then there is nothing to talk to yet.
  const inFactory = (Boolean(conversation.issueUrl) || opened !== null) && !conversation.epic;
  const sendErr = (send.error ?? retry.error) as ApiError | null;
  const noClaude = sendErr?.status === 503;
  const specPending = conversation.specStatus === "pending";
  const composerBusy = send.isPending || answering;
  // Spanning the project until it becomes an epic, which lives in one repository.
  const acrossProject = conversation.scope === "project" && !conversation.epic;

  return (
    <div className="shape-conv">
      <header className="shape-head">
        <div>
          <p className="crumb">
            <Link to="/shape">Shape</Link> › {conversation.title}
          </p>
          <h1>{conversation.title}</h1>
          <p className="muted">
            {acrossProject ? <ProjectChip name={conversation.project?.name ?? "the project"} /> : <RepoChip fullName={conversation.repo} />}
            {conversation.epic ? (
              <>
                {" · "}About <Link to={`/work/${conversation.epic.id}`}>{conversation.epic.title}</Link> · reads its branch and documents
              </>
            ) : acrossProject ? (
              <> · reads the latest main of every repository in {conversation.project?.name ?? "the project"}</>
            ) : (
              <> · reads the latest main of {shortRepo(conversation.repo)} and the project's other repositories</>
            )}
          </p>
        </div>
        <div className="shape-actions">
          <button
            type="button"
            className="secondary"
            disabled={writeSpec.isPending || specPending || messages.length === 0}
            onClick={() => (conversation.spec && !showSpec ? setShowSpec(true) : writeSpec.mutate())}
          >
            {specPending ? "Writing…" : conversation.spec ? (showSpec ? "Requirement" : "Show the requirement") : "Write the requirement"}
          </button>
          <button type="button" className="primary" disabled={!conversation.spec || inFactory} onClick={() => setOpening(true)}>
            Open as work
          </button>
        </div>
      </header>
      {writeSpec.isError && <p className="decision-failure">{failureText(writeSpec.error)}</p>}
      {(opened || conversation.issueUrl) && !conversation.epic && (
        <div className="banner success" role="status">
          Opened as work: {opened?.epicId ? <Link to={`/work/${opened.epicId}`}>{opened.title}</Link> : <a href={opened?.htmlUrl ?? conversation.issueUrl ?? "#"} target="_blank" rel="noreferrer">{opened?.title ?? conversation.title}</a>}. The factory reads it and comes back with a plan.
        </div>
      )}

      <div className={`shape-body${showSpec ? " with-spec" : ""}`}>
        <section className="card shape-chat" aria-label="Conversation">
          <div className="shape-messages">
            {messages.length === 0 && (
              <div className="shape-start">
                <p className="muted">
                  {conversation.epic
                    ? `Ask anything about ${conversation.epic.title}, or paste a screenshot. Some ways to start:`
                    : `Ask anything about ${acrossProject ? (conversation.project?.name ?? "the project") : shortRepo(conversation.repo)}, or paste a screenshot. Some ways to start:`}
                </p>
                <div className="shape-chips">
                  {(conversation.epic ? EPIC_SUGGESTIONS : SUGGESTIONS).map((s) => (
                    <button key={s} type="button" className="chip" disabled={composerBusy} onClick={() => send.mutate({ body: s, files: [] })}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <Message key={m.id} m={m} index={i} first={!messages.some((x) => x.role === "assistant" && x.status !== "pending" && x.id !== m.id)} onRetry={(mid) => retry.mutate(mid)} retrying={retry.isPending} />
            ))}
            {send.isPending && !answering && (
              <div className="shape-msg assistant" aria-live="polite">
                <div className="shape-bubble muted">Sending…</div>
              </div>
            )}
            <div ref={endRef} />
          </div>
          {(send.isError || retry.isError) && (
            <div className="banner error">
              {noClaude ? (
                <>
                  {sendErr?.message} <Link to="/settings">Open Settings</Link>.
                </>
              ) : (
                failureText(send.error ?? retry.error)
              )}
            </div>
          )}
          {inFactory ? (
            <p className="muted">This idea is in the factory now. The conversation continues here once it has a place in Work.</p>
          ) : (
            <div className="shape-composer">
              {pending.length > 0 && (
                <div className="shape-thumbs">
                  {pending.map((p) => (
                    <span key={p.key} className="shape-thumb">
                      <img src={p.dataUrl} alt={p.name} />
                      <button type="button" aria-label={`Remove ${p.name}`} onClick={() => setPending((l) => l.filter((x) => x.key !== p.key))}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                aria-label="Your message"
                rows={3}
                value={text}
                placeholder={answering ? "Waiting for the answer…" : "Describe the idea, ask about the code, or paste a screenshot. Enter sends; Shift+Enter for a new line."}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                onPaste={onPaste}
                onDrop={onDrop}
                onDragOver={(e) => e.preventDefault()}
                disabled={composerBusy}
              />
              <div className="decision-actions">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  multiple
                  hidden
                  aria-label="Attach images"
                  onChange={(e) => {
                    if (e.target.files) void addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button type="button" className="secondary" onClick={() => fileRef.current?.click()} disabled={composerBusy}>
                  Attach image
                </button>
                <button type="button" className="primary" onClick={submit} disabled={composerBusy || (!text.trim() && pending.length === 0)}>
                  {send.isPending ? "Sending…" : answering ? "Waiting…" : "Send"}
                </button>
              </div>
            </div>
          )}
        </section>
        {showSpec && specPending && (
          <aside className="card shape-spec" aria-label="Requirement">
            <h2>Requirement</h2>
            <p className="muted" role="status">
              Writing the requirement… the factory is reading the conversation. This takes a minute or two.
            </p>
          </aside>
        )}
        {showSpec && !specPending && conversation.specStatus === "failed" && !conversation.spec && (
          <aside className="card shape-spec" aria-label="Requirement">
            <h2>Requirement</h2>
            <p className="decision-failure">{conversation.specError ?? "Writing the requirement failed."}</p>
            <button type="button" className="secondary" disabled={writeSpec.isPending} onClick={() => writeSpec.mutate()}>
              Try again
            </button>
          </aside>
        )}
        {showSpec && !specPending && conversation.spec !== null && (
          <SpecPanel id={id} spec={conversation.spec} failedNote={conversation.specStatus === "failed" ? conversation.specError : null} onRewrite={() => writeSpec.mutate()} onClose={() => setShowSpec(false)} onSaved={refresh} />
        )}
      </div>

      {opening && (
        <Sheet title="Open as work" onClose={() => setOpening(false)}>
          <OpenAsWork
            id={id}
            defaultTitle={conversation.title}
            homes={acrossProject ? (conversation.project?.repos ?? []) : []}
            defaultRepoId={conversation.repoId}
            onCancel={() => setOpening(false)}
            onDone={(r) => {
              setOpening(false);
              setOpened(r);
              refresh();
            }}
          />
        </Sheet>
      )}
    </div>
  );
}

/** Whether anything on this conversation is still being written in the background. */
function busy(data: ShapeConversation | undefined): boolean {
  if (!data?.conversation) return false;
  return data.conversation.specStatus === "pending" || (data.messages ?? []).some((m) => m.status === "pending");
}

function Message({ m, index, first, onRetry, retrying }: { m: ShapeMessage; index: number; first: boolean; onRetry: (id: string) => void; retrying: boolean }) {
  if (m.role === "assistant" && m.status === "pending") {
    return (
      <div className="shape-msg assistant" aria-live="polite">
        <div className="shape-bubble muted">{first ? "Thinking… the factory is reading the code. The first answer takes longer." : "Thinking…"}</div>
      </div>
    );
  }
  if (m.role === "assistant" && m.status === "failed") {
    return (
      <div className="shape-msg assistant">
        <div className="shape-bubble assistant shape-failed">
          <p className="decision-failure">{m.error ?? "The answer failed."}</p>
          <button type="button" className="secondary" disabled={retrying} onClick={() => onRetry(m.id)}>
            {retrying ? "Trying…" : "Try again"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={`shape-msg ${m.role}`}>
      {m.role === "user" ? (
        <div className="shape-bubble user">
          {m.attachments.length > 0 && (
            <div className="shape-thumbs">
              {m.attachments.map((a) => (
                <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="shape-thumb">
                  <img src={a.url} alt={a.name} />
                </a>
              ))}
            </div>
          )}
          {m.body && <p>{m.body}</p>}
        </div>
      ) : (
        <div className="shape-bubble assistant">
          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: localTimesHtml(m.bodyHtml, m.createdAt ?? null) }} />
          {m.mocks.map((mock, i) => (
            <Mock key={`${m.id}-${i}`} html={mock.html} n={index * 10 + i + 1} />
          ))}
          {(m.diagrams ?? []).map((d, i) => (
            <Diagram key={`${m.id}-d${i}`} code={d.code} n={index * 10 + i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function Mock({ html, n }: { html: string; n: number }) {
  const [view, setView] = useState<"preview" | "code">("preview");
  const openFull = () => {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return (
    <figure className="shape-mock">
      <figcaption className="row">
        <strong>Mock</strong>
        <span className="shape-toggle" role="tablist">
          <button type="button" role="tab" aria-selected={view === "preview"} className={view === "preview" ? "on" : ""} onClick={() => setView("preview")}>
            Preview
          </button>
          <button type="button" role="tab" aria-selected={view === "code"} className={view === "code" ? "on" : ""} onClick={() => setView("code")}>
            Code
          </button>
        </span>
        <button type="button" className="link" onClick={openFull}>
          Open full size
        </button>
      </figcaption>
      {view === "preview" ? <iframe sandbox="" srcDoc={html} title={`Mock ${n}`} className="shape-frame" /> : <pre className="shape-code">{html}</pre>}
    </figure>
  );
}

function SpecPanel({
  id,
  spec,
  failedNote,
  onRewrite,
  onClose,
  onSaved,
}: {
  id: string;
  spec: string;
  failedNote?: string | null;
  onRewrite: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(spec);
  useEffect(() => setDraft(spec), [spec]);
  const save = useMutation({
    mutationFn: () => api.put(`/api/shape/${id}/spec`, { spec: draft }),
    onSuccess: () => {
      setEditing(false);
      onSaved();
    },
  });
  return (
    <aside className="card shape-spec" aria-label="Requirement">
      <div className="spread">
        <h2>Requirement</h2>
        <span className="row">
          {editing ? (
            <>
              <button type="button" className="primary" disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setDraft(spec);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          <button type="button" className="link" onClick={onClose} aria-label="Close the requirement">
            Close
          </button>
        </span>
      </div>
      <p className="muted">This is the factory requirement, with a draft OpenSpec change the factory starts from when you open it as work. Change anything that is not right.</p>
      {failedNote && (
        <p className="decision-failure">
          The last rewrite failed: {failedNote}{" "}
          <button type="button" className="link" onClick={onRewrite}>
            Try again
          </button>
        </p>
      )}
      {editing ? <textarea className="shape-spec-edit" value={draft} onChange={(e) => setDraft(e.target.value)} rows={24} aria-label="Requirement text" /> : <RequirementView spec={spec} />}
      {save.isError && <p className="decision-failure">{failureText(save.error)}</p>}
    </aside>
  );
}

/** The requirement's form, then its OpenSpec draft one file per fold — proposal open, specs closed. */
function RequirementView({ spec }: { spec: string }) {
  const { form, slug, files } = splitOpenSpec(spec);
  if (files.length === 0) return <SpecView markdown={spec} />;
  return (
    <>
      <SpecView markdown={form} />
      <h3 className="shape-openspec-title">
        OpenSpec draft{slug ? <code>{slug}</code> : null}
      </h3>
      {files.map((f, i) => (
        <details key={f.path} className="shape-openspec-file" open={i === 0}>
          <summary>
            <code>{f.path}</code>
          </summary>
          <SpecView markdown={f.content} />
        </details>
      ))}
    </>
  );
}

/** `**bold**` inside a line, as the spec's WHEN/THEN keywords are written. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : p))}</>;
}

/** A light rendering of the spec's markdown: headings, bullets, numbered lines, paragraphs. */
function SpecView({ markdown }: { markdown: string }) {
  const blocks: Array<{ kind: "h" | "ul" | "ol" | "p"; lines: string[] }> = [];
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) {
      blocks.push({ kind: "h", lines: [line.replace(/^#+\s*/, "")] });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const num = /^\d+[.)]\s+(.*)$/.exec(line);
    const kind = bullet ? "ul" : num ? "ol" : "p";
    const textLine = bullet?.[1] ?? num?.[1] ?? line;
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && kind !== "p") last.lines.push(textLine);
    else blocks.push({ kind, lines: [textLine] });
  }
  return (
    <div className="shape-spec-view">
      {blocks.map((b, i) =>
        b.kind === "h" ? (
          <h3 key={i}>{b.lines[0]}</h3>
        ) : b.kind === "ul" ? (
          <ul key={i}>
            {b.lines.map((l, j) => (
              <li key={j}>
                <Inline text={l} />
              </li>
            ))}
          </ul>
        ) : b.kind === "ol" ? (
          <ol key={i}>
            {b.lines.map((l, j) => (
              <li key={j}>
                <Inline text={l} />
              </li>
            ))}
          </ol>
        ) : (
          <p key={i}>
            <Inline text={b.lines[0]!} />
          </p>
        ),
      )}
    </div>
  );
}

function OpenAsWork({
  id,
  defaultTitle,
  homes,
  defaultRepoId,
  onCancel,
  onDone,
}: {
  id: string;
  defaultTitle: string;
  /** For an idea that spans the project: the repositories the work may open in. Empty when the idea is about one. */
  homes: Array<{ id: string; fullName: string }>;
  defaultRepoId: string;
  onCancel: () => void;
  onDone: (r: { title: string; htmlUrl: string; epicId?: string }) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [fast, setFast] = useState(false);
  const [repoId, setRepoId] = useState(defaultRepoId);
  const open = useMutation({
    mutationFn: () =>
      api.post<{ number: number; htmlUrl: string; epicId?: string }>(`/api/shape/${id}/work`, { title: title.trim(), fast, ...(homes.length ? { repoId } : {}) }),
    onSuccess: (r) => onDone({ title: title.trim(), htmlUrl: r.htmlUrl, epicId: r.epicId }),
  });
  // Shown in a Sheet, which carries the title and the dialog role.
  return (
    <div className="shape-open">
      <p className="muted">The requirement becomes an item in Work. The factory reads it and comes back with a plan for you to approve.</p>
      <label htmlFor="shape-title">Name it</label>
      <input id="shape-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      {homes.length > 0 && (
        <>
          <label htmlFor="shape-home">Where it opens</label>
          <select id="shape-home" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
            {homes.map((h) => (
              <option key={h.id} value={h.id}>
                {shortRepo(h.fullName)}
              </option>
            ))}
          </select>
          <p className="muted shape-hint">The epic lives in this repository. Work in the others is planned from there.</p>
        </>
      )}
      <label className="shape-fast">
        <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} /> Fast lane: the factory approves the plan and the design itself. You still release it.
      </label>
      <div className="decision-actions">
        <button type="button" className="primary" disabled={!title.trim() || open.isPending} onClick={() => open.mutate()}>
          {open.isPending ? "Opening…" : "Open it"}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={open.isPending}>
          Cancel
        </button>
      </div>
      {open.isError && <p className="decision-failure">{failureText(open.error)}</p>}
    </div>
  );
}
