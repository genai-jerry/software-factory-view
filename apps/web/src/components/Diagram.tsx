import { useEffect, useState } from "react";
import { downloadPdf, downloadSvg, mermaidLiveUrl, renderDiagram } from "../lib/diagram.js";

/** A Mermaid diagram from a Shape answer: drawn, with its code, Mermaid Live, SVG and PDF one click away. */
export function Diagram({ code, n }: { code: string; n: number }) {
  const [view, setView] = useState<"preview" | "code">("preview");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const name = `diagram-${n}`;

  useEffect(() => {
    let gone = false;
    setSvg(null);
    setError(null);
    renderDiagram(code)
      .then((s) => !gone && setSvg(s))
      .catch((e: unknown) => !gone && setError(e instanceof Error ? e.message : "Mermaid could not read this diagram."));
    mermaidLiveUrl(code)
      .then((u) => !gone && setLive(u))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [code]);

  const openFull = () => {
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const pdf = async () => {
    if (!svg) return;
    setSaving(true);
    try {
      await downloadPdf(svg, name);
    } catch (e) {
      setError(e instanceof Error ? `The PDF did not save: ${e.message}` : "The PDF did not save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <figure className="shape-mock shape-diagram" aria-label={`Diagram ${n}`}>
      <figcaption className="row">
        <strong>Diagram</strong>
        <span className="shape-toggle" role="tablist">
          <button type="button" role="tab" aria-selected={view === "preview"} className={view === "preview" ? "on" : ""} onClick={() => setView("preview")}>
            Preview
          </button>
          <button type="button" role="tab" aria-selected={view === "code"} className={view === "code" ? "on" : ""} onClick={() => setView("code")}>
            Code
          </button>
        </span>
        <span className="shape-diagram-actions">
          {live && (
            <a href={live} target="_blank" rel="noopener noreferrer">
              Open in Mermaid Live
            </a>
          )}
          <button type="button" className="link" disabled={!svg} onClick={openFull}>
            Full size
          </button>
          <button type="button" className="link" disabled={!svg} onClick={() => svg && downloadSvg(svg, name)}>
            SVG
          </button>
          <button type="button" className="link" disabled={!svg || saving} onClick={pdf}>
            {saving ? "Saving…" : "PDF"}
          </button>
        </span>
      </figcaption>
      {view === "code" ? (
        <pre className="shape-code">{code}</pre>
      ) : error ? (
        <p className="shape-diagram-error" role="alert">
          Mermaid could not draw this: {error} The code is one tab away, and Mermaid Live shows where it breaks.
        </p>
      ) : svg ? (
        // Mermaid's own output under securityLevel "strict": sanitised, no scripts or handlers.
        <div className="shape-diagram-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <p className="muted shape-diagram-wait">Drawing…</p>
      )}
    </figure>
  );
}
