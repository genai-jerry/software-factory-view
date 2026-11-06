/**
 * Times the factory writes, shown in the reader's own time.
 *
 * Everything the Compass formats itself already uses the browser's zone.
 * The text the factory writes — its GitHub comments, QA reports, run errors,
 * answers from "Ask the factory" — says times in UTC ("tests ran 01:47–01:51
 * UTC", "resets 2:50pm (UTC)"), and a reader in India had to add five and a
 * half hours in their head. This rewrites every time that names UTC (or is
 * an ISO timestamp with a zone) into the reader's time; the original stays
 * in the tooltip. A time that names no zone is left alone: nobody can say
 * which zone it meant.
 *
 * A bare clock time ("04:44 UTC") takes its date from when the text was
 * written (`anchor`): the nearest such moment, within twelve hours either
 * way. When that falls on another local day than the anchor, the date is
 * shown too.
 */

const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}|\s?UTC\b|\s?\(UTC\))/g;
const RANGE = /\b(\d{1,2}):(\d{2})\s?[–-]\s?(\d{1,2}):(\d{2})\s?(?:\(UTC\)|UTC\b)/g;
const CLOCK = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s?(?:\(UTC\)|UTC\b)/g;
const TWELVE = /\b(\d{1,2})(?::(\d{2}))?\s?([ap])\.?m\.?\s?(?:\(UTC\)|UTC\b)/gi;

const HALF_DAY = 12 * 3_600_000;

export interface TimePiece {
  /** The text as written, e.g. "04:44 UTC". */
  original: string;
  /** The moment, as ISO. */
  iso: string;
  /** The reader's time, e.g. "10:14 AM" or "5 Nov, 09:24 PM". */
  local: string;
}

export type Piece = string | TimePiece;

function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function localWords(d: Date, anchor: Date): string {
  const sameDay = d.toDateString() === anchor.toDateString();
  return sameDay ? clock(d) : `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${clock(d)}`;
}

/** The UTC moment at hh:mm nearest to `anchor`. */
function nearest(hours: number, minutes: number, anchor: Date): Date | null {
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate(), hours, minutes));
  if (at.getTime() - anchor.getTime() > HALF_DAY) at.setUTCDate(at.getUTCDate() - 1);
  else if (anchor.getTime() - at.getTime() > HALF_DAY) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

interface Hit {
  start: number;
  end: number;
  local: string;
  iso: string;
}

function hits(text: string, anchor: Date): Hit[] {
  const out: Hit[] = [];
  const take = (re: RegExp, read: (m: RegExpExecArray) => { local: string; iso: string } | null) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (out.some((h) => start < h.end && end > h.start)) continue; // a longer match got it
      const got = read(m);
      if (got) out.push({ start, end, ...got });
    }
  };
  take(ISO, (m) => {
    const text = m[0].replace(/\s?\(?UTC\)?$/, "Z").replace(" ", "T");
    const at = new Date(text);
    return Number.isNaN(at.getTime()) ? null : { local: localWords(at, anchor), iso: at.toISOString() };
  });
  take(RANGE, (m) => {
    const a = nearest(+m[1]!, +m[2]!, anchor);
    const b = nearest(+m[3]!, +m[4]!, anchor);
    if (!a || !b) return null;
    return { local: `${localWords(a, anchor)}–${clock(b)}`, iso: a.toISOString() };
  });
  take(TWELVE, (m) => {
    const h = (+m[1]! % 12) + (m[3]!.toLowerCase() === "p" ? 12 : 0);
    const at = nearest(h, +(m[2] ?? 0), anchor);
    return at && { local: localWords(at, anchor), iso: at.toISOString() };
  });
  take(CLOCK, (m) => {
    const at = nearest(+m[1]!, +m[2]!, anchor);
    return at && { local: localWords(at, anchor), iso: at.toISOString() };
  });
  return out.sort((x, y) => x.start - y.start);
}

/** The text split into plain runs and the times in it, each converted. */
export function timePieces(text: string, anchor: Date = new Date()): Piece[] {
  const found = hits(text, anchor);
  if (found.length === 0) return [text];
  const out: Piece[] = [];
  let at = 0;
  for (const h of found) {
    if (h.start > at) out.push(text.slice(at, h.start));
    out.push({ original: text.slice(h.start, h.end), iso: h.iso, local: h.local });
    at = h.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Plain text with its UTC times in the reader's time. */
export function localTimesText(text: string, anchor?: Date | string | null): string {
  return timePieces(text, toDate(anchor))
    .map((p) => (typeof p === "string" ? p : p.local))
    .join("");
}

function toDate(anchor?: Date | string | null): Date {
  if (anchor instanceof Date) return anchor;
  const d = anchor ? new Date(anchor) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Rendered HTML (a comment, a report, a document) with its UTC times in the
 * reader's time, each wrapped in <time> with the original as its title.
 * Code is left as written: a log line or a command is not prose.
 */
export function localTimesHtml(html: string, anchor?: Date | string | null): string {
  if (!html || typeof DOMParser === "undefined" || !/UTC|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(html)) return html;
  const when = toDate(anchor);
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.parentElement?.closest("code, pre, time"))) nodes.push(n as Text);
  }
  let changed = false;
  for (const node of nodes) {
    const pieces = timePieces(node.data, when);
    if (pieces.length === 1 && typeof pieces[0] === "string") continue;
    const frag = doc.createDocumentFragment();
    for (const p of pieces) {
      if (typeof p === "string") frag.append(doc.createTextNode(p));
      else {
        const t = doc.createElement("time");
        t.dateTime = p.iso;
        t.title = p.original;
        t.textContent = p.local;
        frag.append(t);
      }
    }
    node.replaceWith(frag);
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}
