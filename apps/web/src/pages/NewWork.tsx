import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api.js";

/**
 * Add work (redesign board 3): what you want done, why and for whom, where
 * it lives, and how to run it. Start opens the GitHub issue with the intake
 * label; the factory reads it and comes back with a plan to approve.
 */

interface Target {
  id: string;
  fullName: string;
  projectId: string | null;
  projectName: string | null;
  factoryEnabled: boolean;
}

export function NewWorkPage() {
  const navigate = useNavigate();
  const targets = useQuery({ queryKey: ["work-targets"], queryFn: () => api.get<{ targets: Target[] }>("/api/work/targets") });
  const [title, setTitle] = useState("");
  const [why, setWhy] = useState("");
  const [repoId, setRepoId] = useState("");
  const [fast, setFast] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const enabled = (targets.data?.targets ?? []).filter((t) => t.factoryEnabled);
  const chosen = repoId || enabled[0]?.id || "";
  const projects = new Map<string, Target[]>();
  for (const t of enabled) projects.set(t.projectName ?? "Other", [...(projects.get(t.projectName ?? "Other") ?? []), t]);

  const start = useMutation({
    mutationFn: () => api.post<{ ok: boolean; number: number; htmlUrl: string; repo: string }>("/api/work", { repoId: chosen, title: title.trim(), body: why.trim(), fast }),
    onSuccess: (r) => navigate("/", { state: { added: { number: r.number, title: title.trim(), htmlUrl: r.htmlUrl } } }),
    onError: (e) => setFailure(e instanceof ApiError ? e.message : "That did not go through. Try again."),
  });

  return (
    <div className="work-item new-work">
      <p className="crumb">
        <Link to="/">Work</Link> › Add work
      </p>
      <h1>Add work</h1>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() && chosen) start.mutate();
        }}
      >
        <label htmlFor="nw-title">What do you want done?</label>
        <input id="nw-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Show day-wise calling performance in the leads page" required />

        <label htmlFor="nw-why">Why, and for whom</label>
        <textarea id="nw-why" rows={5} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Two or three sentences are enough. The factory asks if something is unclear." />

        <label htmlFor="nw-repo">Where it lives</label>
        {targets.isLoading ? (
          <p className="muted">Reading the projects…</p>
        ) : enabled.length === 0 ? (
          <p className="muted">
            No repository is set up for the factory yet. <Link to="/onboarding">Finish setup on Onboarding</Link>.
          </p>
        ) : (
          <select id="nw-repo" value={chosen} onChange={(e) => setRepoId(e.target.value)}>
            {[...projects.entries()].map(([name, list]) => (
              <optgroup key={name} label={name}>
                {list.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName.split("/")[1]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        <p className="muted">The item is filed in that repository. Work that spans repositories starts in the one that owns most of it.</p>

        <fieldset className="nw-mode">
          <legend>How to run it</legend>
          <label className="nw-choice">
            <input type="radio" name="mode" checked={!fast} onChange={() => setFast(false)} />
            <span>
              <strong>Normal.</strong> You approve the plan and the design before anything is built.
            </span>
          </label>
          <label className="nw-choice">
            <input type="radio" name="mode" checked={fast} onChange={() => setFast(true)} />
            <span>
              <strong>Fast.</strong> The factory approves the plan and the design itself, and starts each task. You still release it.
            </span>
          </label>
        </fieldset>

        <div className="decision-actions">
          <button type="submit" className="primary" disabled={!title.trim() || !chosen || start.isPending}>
            {start.isPending ? "Starting…" : "Start"}
          </button>
          <Link to="/" className="button">
            Cancel
          </Link>
        </div>
        {failure && <p className="decision-failure">{failure}</p>}
      </form>

      <section className="card">
        <h2>What happens next</h2>
        <ol className="facts">
          <li>The factory reads your write-up and comes back with a plan, usually within fifteen minutes.</li>
          <li>You agree the plan's items here. Nothing is built until you approve it.</li>
          <li>Then the design, the build, the tests and the release, each with one decision for a person.</li>
          <li>The item appears in Work as soon as GitHub tells Compass about it, usually within a minute.</li>
        </ol>
      </section>
    </div>
  );
}
