import { ROLE_START_STATE, STAGE_LABEL, isRoleStart, plainTitle, type WorkItem } from "@console/core";
import { clip, esc, type Keyboard } from "./client.js";

/**
 * A decision as a Telegram message (openspec telegram-decisions): the same
 * words as its Decisions card, titles not numbers, and buttons for what can
 * be decided from a phone. `nid` is the notification id the buttons carry.
 */

export function gateWhat(state: string | null | undefined): { title: string; need: string; button: string; after: string } {
  if (state === "factory:spec-ready")
    return { title: "Approve the plan", need: "agree the plan the factory wrote, or ask for a change.", button: "Approve the plan", after: "Approving starts the design." };
  if (state === "factory:design-ready")
    return {
      title: "Approve the design",
      need: "confirm the design decisions, or ask for a change.",
      button: "Approve the design",
      after: "Approving starts the build. You are asked again only if a builder gets stuck.",
    };
  if (state === "factory:epic-ready")
    return {
      title: "Release to staging",
      need: "decide whether this goes to staging.",
      button: "Release to staging",
      after: "Releasing merges the epic onto the staging branch and deploys it there.",
    };
  return { title: "Approve at this gate", need: "approve, or ask for a change.", button: "Approve", after: "" };
}

export function shortRepo(fullName: string): string {
  return fullName.split("/")[1] ?? fullName;
}

/** Up to five role starts get their own button; the rest are in Compass. */
export function roleStarts(w: WorkItem) {
  return w.entries.filter(isRoleStart).slice(0, 5);
}

export function openUrl(origin: string, w: WorkItem): string | null {
  // Telegram refuses URL buttons that are not public https links (localhost in dev).
  if (!/^https:\/\//.test(origin) || /localhost|127\.0\.0\.1/.test(origin)) return null;
  return `${origin.replace(/\/$/, "")}${w.link}`;
}

export function renderDecision(w: WorkItem, nid: string, origin: string): { html: string; keyboard: Keyboard } {
  const head = `<b>${esc(w.card.title)}</b> · ${esc(shortRepo(w.card.repo))}`;
  const stage = w.stage ? STAGE_LABEL[w.stage] : "Held";
  const t = w.card.tasks;
  const lines: string[] = [];
  const kb: Keyboard = [];
  const gate = w.entries.find((e) => e.kind === "gate");
  switch (w.ask) {
    case "decide":
    case "release": {
      const what = gateWhat(gate?.state);
      lines.push(`<b>${esc(what.title)}</b>`, `You need to: ${esc(what.need)}`);
      if (t.total > 0) lines.push(`• ${t.total} task${t.total === 1 ? "" : "s"}, ${t.done + t.shipping} built.`);
      if (t.tests && t.tests.total > 0) lines.push(`• ${t.tests.passed} of ${t.tests.total} tests passed.`);
      if (t.bugs && t.bugs.open > 0) lines.push(`• ${t.bugs.open} bug${t.bugs.open === 1 ? "" : "s"} still open.`);
      if (what.after) lines.push(`• ${esc(what.after)}`);
      kb.push([{ text: what.button, callback_data: `go:${nid}` }]);
      kb.push([{ text: "Discuss or ask for changes", callback_data: `ds:${nid}` }]);
      break;
    }
    case "answer": {
      const e = w.entries.find((x) => x.kind === "blocked");
      lines.push("<b>The builder stopped and asked a question</b>", "You need to: answer it. The builder continues once you do.");
      if (e) lines.push(`• On: ${esc(plainTitle(e.title) || e.title)}`);
      if (e?.question) lines.push(`• “${esc(clip(e.question, 1500))}”`);
      lines.push("", "<i>Reply to this message to answer or talk it through. Nothing is posted until you confirm.</i>");
      kb.push([{ text: "Answer or discuss", callback_data: `ds:${nid}` }]);
      break;
    }
    case "review": {
      const starts = roleStarts(w);
      lines.push("<b>Start the next step</b>", "You need to: start each one. The factory does not start it by itself.");
      starts.forEach((e, i) => {
        const noun = ROLE_START_STATE[e.state!]!.noun;
        lines.push(`• ${esc(plainTitle(e.title) || e.title)} — waits for its ${noun}`);
        kb.push([{ text: `Start the ${noun}: ${clip(plainTitle(e.title) || e.title, 40)}`, callback_data: `st:${nid}:${i}` }]);
      });
      const more = w.entries.filter(isRoleStart).length - starts.length;
      if (more > 0) lines.push(`• and ${more} more in Compass`);
      kb.push([{ text: "Discuss", callback_data: `ds:${nid}` }]);
      break;
    }
    case "act": {
      const e = w.entries.find((x) => x.kind === "request");
      lines.push("<b>The factory needs you before it can release</b>", `You need to: ${esc(e?.question ?? "do what the factory asked on the item.")}`);
      if (e?.approvedBy) lines.push(`• Your release approval (@${esc(e.approvedBy)}) stands; nothing to approve again.`);
      if (e?.requestLink && /^https:\/\//.test(e.requestLink)) kb.push([{ text: "Open it on GitHub", url: e.requestLink }]);
      kb.push([{ text: "Discuss", callback_data: `ds:${nid}` }]);
      break;
    }
    case "ship":
      lines.push("<b>Ship to production</b>", "You need to: decide whether this goes live for customers now.", "• It is on staging and every check passed.", "• Shipping merges the promotion pull requests. That stays in Compass.");
      kb.push([{ text: "Discuss", callback_data: `ds:${nid}` }]);
      break;
    case "run":
      lines.push("<b>Run tests</b>", `You need to: ${esc(w.pointer.replace(/^Run: /, ""))}`, "• Results are recorded on the test page in Compass.");
      kb.push([{ text: "Discuss", callback_data: `ds:${nid}` }]);
      break;
    case "start":
      lines.push("<b>Start the build</b>", `You need to: start the tasks that are ready. ${esc(w.pointer.replace(/^Start: /, ""))}`);
      kb.push([{ text: "Discuss", callback_data: `ds:${nid}` }]);
      break;
    default:
      lines.push(esc(w.pointer));
  }
  const url = openUrl(origin, w);
  if (url) kb.push([{ text: "Open in Compass", url }]);
  return { html: clip(`${head}\n<i>${esc(stage)}</i>\n\n${lines.join("\n")}`), keyboard: kb };
}

export const RESOLVED_SUFFIX = "\n\n✅ <b>Done</b> — no longer waiting on you.";
