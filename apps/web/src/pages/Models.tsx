import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { ApiError, api } from "../api.js";
import type { Me } from "../types.js";

interface Step {
  key: string;
  label: string;
  detail: string;
}

interface Phase {
  id: string;
  label: string;
  detail: string;
  steps: Step[];
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
  maxChain: number;
  org: ScopeChains;
  projects: Array<{ id: string; name: string } & ScopeChains>;
}

interface AvailableModel {
  id: string;
  name: string;
  deprecated: boolean;
}

type Available =
  | { ok: true; source: "known" | "api-key"; models: AvailableModel[]; listedAt: string }
  | { ok: false; error: string };

/** Two slots per setting: the first choice, and the one used when it cannot be reached. */
const SLOTS = 2;

const phaseKey = (p: Phase) => `phase:${p.id}`;

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : "That did not go through. Try again.";
}

/**
 * Compass → Models: which Claude model each phase of the factory runs on,
 * and each step inside a phase where one needs something else — for the
 * whole organisation, and per project. The choices are the models Claude
 * lists for the factory's own credential.
 */
export function ModelsPage({ me }: { me: Me }) {
  return (
    <div>
      <h1>Models</h1>
      <p className="muted">
        The Claude model each phase runs on. Set a phase once for every step in it, or open the phase and set a step on its own. The first choice is used
        when the factory&apos;s Claude sign-in can reach it, otherwise the next one. Anything left unset keeps what it uses today: the repository&apos;s{" "}
        <code>.github/factory-models.json</code>, or the factory&apos;s default. A change applies from the next run or message.
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
  const qc = useQueryClient();
  const available = useQuery({ queryKey: ["org-models-available", orgId], queryFn: () => api.get<Available>(`/api/orgs/${orgId}/models/available`) });
  const refresh = useMutation({
    mutationFn: () => api.get<Available>(`/api/orgs/${orgId}/models/available?refresh=1`),
    onSuccess: (r) => qc.setQueryData(["org-models-available", orgId], r),
  });
  const [scope, setScope] = useState("org");
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.isError || !q.data) return <div className="banner error">{errorText(q.error)}</div>;
  const d = q.data;
  const project = d.projects.find((p) => p.id === scope);
  const current = project ?? d.org;
  const listed = available.data?.ok ? available.data.models : null;
  // A fixed list is a suggestion, not what the credential can use: any id may be typed.
  const suggestOnly = available.data?.ok === true && available.data.source === "known";

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
          ? `What you set here applies to ${project.name}'s repositories and conversations. Anything left unset uses the organisation's choice.`
          : "What you set here applies to every project, unless a project sets it itself."}
      </p>

      <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem", alignItems: "baseline" }}>
        {available.isLoading && <span className="muted">Finding the models on offer…</span>}
        {available.data?.ok && (
          <span className="muted">
            {available.data.source === "known" ? (
              <>
                {available.data.models.length} current Claude models. With only a Claude sign-in stored, Compass does not ask Claude for the list; type
                any other model id.
              </>
            ) : (
              <>
                {available.data.models.length} models offered to the factory&apos;s API key, listed {new Date(available.data.listedAt).toLocaleTimeString()}.
              </>
            )}
          </span>
        )}
        {available.data && !available.data.ok && <span className="decision-failure">{available.data.error} You can still type a model id.</span>}
        {available.isError && <span className="decision-failure">{errorText(available.error)}</span>}
        <button type="button" className="secondary" disabled={refresh.isPending || available.isLoading} onClick={() => refresh.mutate()}>
          {refresh.isPending ? "Listing…" : "List again"}
        </button>
      </div>

      <ChainsForm
        key={`${scope}:${current.updatedAt ?? ""}`}
        orgId={orgId}
        scope={scope}
        phases={d.phases}
        listed={listed}
        suggestOnly={suggestOnly}
        value={current.chains}
        inherited={project ? d.org.chains : null}
        canEdit={d.canEdit}
        updatedBy={current.updatedBy}
        updatedAt={current.updatedAt}
      />
    </section>
  );
}

/**
 * One model slot: a list of what Claude offers when it answered, a typed id
 * with suggestions when the list is Compass's own, else a typed id.
 */
function ModelSlot({
  label,
  value,
  listed,
  suggestOnly,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  listed: AvailableModel[] | null;
  suggestOnly: boolean;
  placeholder: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const style = { flex: "1 1 12rem", minWidth: 0 };
  const suggestions = useId();
  if (listed && suggestOnly) {
    return (
      <>
        <input aria-label={label} list={suggestions} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={style} />
        <datalist id={suggestions}>
          {listed.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </datalist>
      </>
    );
  }
  if (!listed) {
    return <input aria-label={label} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={style} />;
  }
  const known = listed.some((m) => m.id === value);
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={style}>
      <option value="">{placeholder}</option>
      {value && !known && <option value={value}>{value} (not offered to this credential)</option>}
      {listed.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name} — {m.id}
          {m.deprecated ? " (being retired)" : ""}
        </option>
      ))}
    </select>
  );
}

function ChainsForm({
  orgId,
  scope,
  phases,
  listed,
  suggestOnly,
  value,
  inherited,
  canEdit,
  updatedBy,
  updatedAt,
}: {
  orgId: string;
  scope: string;
  phases: Phase[];
  listed: AvailableModel[] | null;
  suggestOnly: boolean;
  value: Record<string, string[]>;
  /** For a project: the organisation's chains, shown where the project sets nothing. */
  inherited: Record<string, string[]> | null;
  canEdit: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}) {
  const qc = useQueryClient();
  const keys = phases.flatMap((p) => [phaseKey(p), ...p.steps.map((s) => s.key)]);
  const [draft, setDraft] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(keys.map((k) => [k, Array.from({ length: SLOTS }, (_, i) => value[k]?.[i] ?? "")])),
  );
  // A phase with a step set on its own starts open, so what is set is in view.
  const [open, setOpen] = useState<Set<string>>(() => new Set(phases.filter((p) => p.steps.some((s) => value[s.key]?.length)).map((p) => p.id)));
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
  const chainOf = (key: string) => draft[key]!.map((m) => m.trim()).filter(Boolean);
  const show = (list: string[]) => list.join(", then ");
  /** What a phase falls back to when it sets nothing here. */
  const phaseFallback = (p: Phase) => {
    const org = inherited?.[phaseKey(p)];
    return org?.length ? `the organisation's ${p.label}: ${show(org)}` : "the repository's file, or the factory's default";
  };
  /** What a step falls back to when it sets nothing here. */
  const stepFallback = (p: Phase, s: Step) => {
    const here = chainOf(phaseKey(p));
    if (here.length) return `${p.label}: ${show(here)}`;
    const org = inherited?.[s.key];
    if (org?.length) return `the organisation's ${s.label}: ${show(org)}`;
    return phaseFallback(p);
  };
  const busy = !canEdit || save.isPending;

  return (
    <div>
      {phases.map((p) => {
        const isOpen = open.has(p.id);
        const stepsSet = p.steps.filter((s) => chainOf(s.key).length).length;
        return (
          <fieldset key={p.id} style={{ border: 0, borderTop: "1px solid var(--border)", padding: "0.8rem 0", margin: 0 }}>
            <legend className="sr-only">{p.label}</legend>
            <div>
              <strong>{p.label}</strong> <span className="muted">— {p.detail}</span>
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem", alignItems: "center", marginTop: "0.3rem" }}>
              {draft[phaseKey(p)]!.map((m, i) => (
                <ModelSlot
                  key={i}
                  label={`${p.label}: ${i === 0 ? "first choice" : "if that is unavailable"}`}
                  value={m}
                  listed={listed}
                  suggestOnly={suggestOnly}
                  placeholder={i === 0 ? "First choice" : "If unavailable"}
                  disabled={busy}
                  onChange={(v) => set(phaseKey(p), i, v)}
                />
              ))}
            </div>
            {chainOf(phaseKey(p)).length === 0 && <div className="muted">Uses {phaseFallback(p)}.</div>}
            {p.steps.length > 1 || p.steps[0]!.label !== p.label ? (
              <button
                type="button"
                className="link"
                aria-expanded={isOpen}
                onClick={() => setOpen((o) => (o.has(p.id) ? new Set([...o].filter((x) => x !== p.id)) : new Set([...o, p.id])))}
              >
                {isOpen ? "Hide the steps" : `Set each step (${p.steps.map((s) => s.label).join(", ")})`}
                {!isOpen && stepsSet > 0 ? ` — ${stepsSet} set on its own` : ""}
              </button>
            ) : null}
            {isOpen && (
              <div style={{ marginLeft: "1rem", borderLeft: "2px solid var(--border)", paddingLeft: "0.8rem" }}>
                {p.steps.map((s) => (
                  <div key={s.key} style={{ padding: "0.5rem 0" }}>
                    <div>
                      {s.label} <span className="muted">— {s.detail}</span>
                    </div>
                    <div className="row" style={{ flexWrap: "wrap", gap: "0.5rem", alignItems: "center", marginTop: "0.3rem" }}>
                      {draft[s.key]!.map((m, i) => (
                        <ModelSlot
                          key={i}
                          label={`${p.label} › ${s.label}: ${i === 0 ? "first choice" : "if that is unavailable"}`}
                          value={m}
                          listed={listed}
                          suggestOnly={suggestOnly}
                          placeholder={i === 0 ? "Same as the phase" : "If unavailable"}
                          disabled={busy}
                          onChange={(v) => set(s.key, i, v)}
                        />
                      ))}
                    </div>
                    {chainOf(s.key).length === 0 && <div className="muted">Uses {stepFallback(p, s)}.</div>}
                  </div>
                ))}
              </div>
            )}
          </fieldset>
        );
      })}
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
