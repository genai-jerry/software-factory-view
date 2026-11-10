import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api.js";
import type { Me } from "../types.js";

interface Phase {
  key: string;
  label: string;
  detail: string;
  group: "talk" | "build" | "support";
}

interface ScopeChains {
  chains: Record<string, string[]>;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface OrgModels {
  orgId: string;
  orgName: string;
  canEdit: boolean;
  phases: Phase[];
  choices: string[];
  maxChain: number;
  org: ScopeChains;
  projects: Array<{ id: string; name: string } & ScopeChains>;
}

const GROUPS: Array<{ key: Phase["group"]; title: string }> = [
  { key: "talk", title: "Conversations" },
  { key: "build", title: "Building" },
  { key: "support", title: "Behind the scenes" },
];

/** Two slots per phase: the first choice, and the one used when it cannot be reached. */
const SLOTS = 2;

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : "That did not go through. Try again.";
}

/**
 * Compass → Models: which Claude model each phase of the factory runs on —
 * for the whole organisation, and per project where one needs something
 * else. A phase left blank falls back (project → organisation → the repo's
 * `.github/factory-models.json` → the factory's default).
 */
export function ModelsPage({ me }: { me: Me }) {
  return (
    <div>
      <h1>Models</h1>
      <p className="muted">
        The Claude model each phase runs on. The first choice is used when the factory&apos;s Claude sign-in can reach it, otherwise the next one. Leave a
        phase blank to keep what it uses today: the repository&apos;s <code>.github/factory-models.json</code>, or the factory&apos;s default. A change
        applies from the next run or message.
      </p>
      {me.orgs.map((o) => (
        <OrgModelsCard key={o.id} orgId={o.id} />
      ))}
      {me.orgs.length === 0 && <p className="muted">No orgs yet — connect an organisation first.</p>}
    </div>
  );
}

function OrgModelsCard({ orgId }: { orgId: string }) {
  const q = useQuery({ queryKey: ["org-models", orgId], queryFn: () => api.get<OrgModels>(`/api/orgs/${orgId}/models`) });
  const [scope, setScope] = useState("org");
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.isError || !q.data) return <div className="banner error">{errorText(q.error)}</div>;
  const d = q.data;
  const project = d.projects.find((p) => p.id === scope);
  const current = project ?? d.org;
  return (
    <section className="card">
      <h2>{d.orgName}</h2>
      <label htmlFor={`models-scope-${orgId}`}>Set for</label>
      <select id={`models-scope-${orgId}`} value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value="org">Every project (the organisation)</option>
        {d.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} only
          </option>
        ))}
      </select>
      <p className="muted">
        {project
          ? `What you set here applies to ${project.name}'s repositories and conversations. A blank phase uses the organisation's choice.`
          : "What you set here applies to every project, unless a project sets that phase itself."}
      </p>
      <datalist id={`models-choices-${orgId}`}>
        {d.choices.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <ChainsForm
        key={`${scope}:${current.updatedAt ?? ""}`}
        orgId={orgId}
        scope={scope}
        phases={d.phases}
        listId={`models-choices-${orgId}`}
        value={current.chains}
        inherited={project ? d.org.chains : null}
        canEdit={d.canEdit}
        updatedBy={current.updatedBy}
        updatedAt={current.updatedAt}
      />
    </section>
  );
}

function ChainsForm({
  orgId,
  scope,
  phases,
  listId,
  value,
  inherited,
  canEdit,
  updatedBy,
  updatedAt,
}: {
  orgId: string;
  scope: string;
  phases: Phase[];
  listId: string;
  value: Record<string, string[]>;
  /** For a project: the organisation's chains, shown where the project sets nothing. */
  inherited: Record<string, string[]> | null;
  canEdit: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}) {
  const qc = useQueryClient();
  const fill = (v: Record<string, string[]>) => Object.fromEntries(phases.map((p) => [p.key, Array.from({ length: SLOTS }, (_, i) => v[p.key]?.[i] ?? "")]));
  const [draft, setDraft] = useState<Record<string, string[]>>(() => fill(value));
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [draft]);
  const save = useMutation({
    mutationFn: () => {
      const chains: Record<string, string[]> = {};
      for (const [k, list] of Object.entries(draft)) {
        const models = list.map((m) => m.trim()).filter(Boolean);
        if (models.length > 0) chains[k] = models;
      }
      return api.put(`/api/orgs/${orgId}/models/${scope}`, { chains });
    },
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ["org-models", orgId] });
    },
  });
  const set = (key: string, i: number, v: string) => setDraft((d) => ({ ...d, [key]: d[key]!.map((x, j) => (j === i ? v : x)) }));
  const fallback = (key: string) => {
    const org = inherited?.[key];
    return org?.length ? `Organisation: ${org.join(", then ")}` : "The repository's file, or the factory's default";
  };

  return (
    <div>
      {GROUPS.map((g) => (
        <fieldset key={g.key} style={{ border: 0, padding: 0, margin: "1rem 0 0" }}>
          <legend>
            <h3 style={{ margin: 0 }}>{g.title}</h3>
          </legend>
          {phases
            .filter((p) => p.group === g.key)
            .map((p) => {
              const blank = draft[p.key]!.every((m) => !m.trim());
              return (
                <div key={p.key} className="model-phase" style={{ borderTop: "1px solid var(--border)", padding: "0.6rem 0" }}>
                  <div>
                    <strong>{p.label}</strong> <span className="muted">— {p.detail}</span>
                  </div>
                  <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem", alignItems: "center", marginTop: "0.3rem" }}>
                    {draft[p.key]!.map((m, i) => (
                      <input
                        key={i}
                        aria-label={`${p.label}: ${i === 0 ? "first choice" : "if that is unavailable"}`}
                        list={listId}
                        value={m}
                        placeholder={i === 0 ? "First choice" : "If unavailable"}
                        disabled={!canEdit || save.isPending}
                        onChange={(e) => set(p.key, i, e.target.value)}
                        style={{ flex: "1 1 12rem", minWidth: 0 }}
                      />
                    ))}
                  </div>
                  {blank && <div className="muted">Uses: {fallback(p.key)}</div>}
                </div>
              );
            })}
        </fieldset>
      ))}
      {canEdit ? (
        <div className="decision-actions" style={{ marginTop: "1rem" }}>
          <button type="button" className="primary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
          {saved && <span className="muted">Saved. The next run uses it.</span>}
        </div>
      ) : (
        <p className="muted">An org admin changes the models.</p>
      )}
      {save.isError && <p className="decision-failure">{errorText(save.error)}</p>}
      {updatedBy && updatedAt && (
        <p className="muted">
          Last changed by @{updatedBy} on {new Date(updatedAt).toLocaleString()}.
        </p>
      )}
    </div>
  );
}
