/**
 * Mermaid diagrams in Shape: draw one, link it to Mermaid Live, and save it
 * as SVG or PDF. The three libraries are loaded on first use, so the page
 * pays for them only when an answer carries a diagram. They are bundled, not
 * fetched from a CDN, because nginx sends `script-src 'self'`.
 */

let counter = 0;
let ready: Promise<typeof import("mermaid").default> | null = null;

function mermaid(): Promise<typeof import("mermaid").default> {
  ready ??= import("mermaid").then((m) => {
    const lib = m.default;
    lib.initialize({
      startOnLoad: false,
      // Strict: no click handlers, no HTML in labels, output sanitised.
      securityLevel: "strict",
      theme: "default",
      // SVG text rather than HTML in <foreignObject>, so the PDF has its labels.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    return lib;
  });
  return ready;
}

/** The diagram as an SVG string, or throws with Mermaid's own parse error. */
export async function renderDiagram(code: string): Promise<string> {
  const lib = await mermaid();
  counter += 1;
  const { svg } = await lib.render(`shape-diagram-${counter}`, code);
  return svg;
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A mermaid.live editor link carrying the diagram. Its `pako:` state is the
 * editor's JSON, zlib-deflated and base64url-encoded — `CompressionStream`'s
 * "deflate" is that same zlib format, so no compression library is needed.
 */
export async function mermaidLiveUrl(code: string): Promise<string> {
  const state = JSON.stringify({ code, mermaid: JSON.stringify({ theme: "default" }), autoSync: true, updateDiagram: true });
  const stream = new Response(new TextEncoder().encode(state)).body!.pipeThrough(new CompressionStream("deflate"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return `https://mermaid.live/edit#pako:${base64Url(bytes)}`;
}

/** Width and height in points, from the SVG's viewBox (Mermaid always sets one). */
export function svgSize(svg: string): { width: number; height: number } {
  const m = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
  const width = m ? Number(m[1]) : 800;
  const height = m ? Number(m[2]) : 600;
  return { width: width > 0 ? width : 800, height: height > 0 ? height : 600 };
}

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadSvg(svg: string, name: string): void {
  save(new Blob([svg], { type: "image/svg+xml" }), `${name}.svg`);
}

/** A one-page PDF the size of the diagram, with a margin. */
export async function downloadPdf(svg: string, name: string): Promise<void> {
  const [{ jsPDF }] = await Promise.all([import("jspdf"), import("svg2pdf.js")]);
  const { width, height } = svgSize(svg);
  const margin = 24;
  const doc = new jsPDF({
    orientation: width > height ? "landscape" : "portrait",
    unit: "pt",
    format: [width + margin * 2, height + margin * 2],
  });
  // svg2pdf reads computed styles, so the element is laid out off-screen for the call.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;";
  host.innerHTML = svg;
  document.body.appendChild(host);
  try {
    const el = host.querySelector("svg");
    if (!el) throw new Error("The diagram has no drawing to save.");
    await doc.svg(el, { x: margin, y: margin, width, height });
    doc.save(`${name}.pdf`);
  } finally {
    host.remove();
  }
}
