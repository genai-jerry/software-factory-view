import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api.js";
import { useFocus } from "../lib/filter.js";
import { IMAGE_MIMES, MAX_IMAGES, dataB64Of, pickImages, type PendingImage } from "../lib/images.js";
import { defaultWorkRepo, groupedTargets, rememberWorkRepo, type WorkTarget } from "../lib/work-home.js";

/**
 * Add work (redesign board 3): what you want done, why and for whom, where
 * it lives, and how to run it, with screenshots or mock-ups attached. Start
 * uploads the images to the Console, then opens the GitHub issue with the
 * intake label and links to them; the factory reads it and comes back with
 * a plan to approve.
 */

type Target = WorkTarget;

export function NewWorkPage() {
  const navigate = useNavigate();
  const focus = useFocus();
  const targets = useQuery({ queryKey: ["work-targets"], queryFn: () => api.get<{ targets: Target[] }>("/api/work/targets") });
  const [title, setTitle] = useState("");
  const [why, setWhy] = useState("");
  const [repoId, setRepoId] = useState("");
  const [fast, setFast] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [images, setImages] = useState<PendingImage[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const enabled = (targets.data?.targets ?? []).filter((t) => t.factoryEnabled);
  // The top bar's project or repo decides where work goes unless the person picks.
  const chosen = repoId || defaultWorkRepo(enabled, focus);
  const projects = groupedTargets(enabled, focus.project);

  const start = useMutation({
    mutationFn: async () => {
      // The images go up first; the issue links to them.
      const attachmentIds: string[] = [];
      for (const img of images) {
        const up = await api.post<{ id: string }>("/api/work/attachments", { repoId: chosen, name: img.name, mime: img.mime, dataB64: dataB64Of(img) });
        attachmentIds.push(up.id);
      }
      return api.post<{ ok: boolean; number: number; htmlUrl: string; repo: string }>("/api/work", {
        repoId: chosen,
        title: title.trim(),
        body: why.trim(),
        fast,
        ...(attachmentIds.length ? { attachmentIds } : {}),
      });
    },
    onSuccess: (r) => {
      rememberWorkRepo(enabled.find((t) => t.id === chosen));
      navigate("/", { state: { added: { number: r.number, title: title.trim(), htmlUrl: r.htmlUrl } } });
    },
    onError: (e) => setFailure(e instanceof ApiError ? e.message : "That did not go through. Try again."),
  });

  const addFiles = async (files: FileList | File[]) => {
    const picked = await pickImages(files);
    if (picked.length) setImages((l) => [...l, ...picked].slice(0, MAX_IMAGES));
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
        <textarea
          id="nw-why"
          rows={5}
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          placeholder="Two or three sentences are enough. Paste or drop a screenshot here. The factory asks if something is unclear."
        />

        <div className="nw-images">
          {images.length > 0 && (
            <div className="shape-thumbs">
              {images.map((p) => (
                <span key={p.key} className="shape-thumb">
                  <img src={p.dataUrl} alt={p.name} />
                  <button type="button" aria-label={`Remove ${p.name}`} onClick={() => setImages((l) => l.filter((x) => x.key !== p.key))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
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
          <button type="button" className="secondary" onClick={() => fileRef.current?.click()} disabled={images.length >= MAX_IMAGES}>
            Attach image
          </button>
          <span className="muted"> Screenshots or mock-ups, up to {MAX_IMAGES}. They are kept in Compass and linked from the item.</span>
        </div>

        <label htmlFor="nw-repo">Where it lives</label>
        {targets.isLoading ? (
          <p className="muted">Reading the projects…</p>
        ) : enabled.length === 0 ? (
          <p className="muted">
            No repository is set up for the factory yet. <Link to="/onboarding">Finish setup on Onboarding</Link>.
          </p>
        ) : (
          <select id="nw-repo" value={chosen} onChange={(e) => setRepoId(e.target.value)}>
            {projects.map(([name, list]) => (
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
