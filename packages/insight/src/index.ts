import Anthropic from "@anthropic-ai/sdk";

/**
 * The insight service (spec 01 §5): grounded, cited, bounded, read-only.
 * It receives an already-assembled context — it holds no credentials of any
 * kind and cannot fetch or write. Context assembly happens in the API layer,
 * bounded to the epic's own surfaces; this module's only power is to call the
 * model and shape a cited answer.
 */

export interface InsightSource {
  /** Stable reference the UI turns into a source chip, e.g. "proposal.md@ab12cd3" or "comment/IC_xyz". */
  ref: string;
  kind: "artifact" | "comment" | "pr" | "run" | "profile" | "handbook";
  title: string;
  content: string;
}

export interface InsightAnswer {
  answer: string;
  citations: Array<{ kind: string; ref: string; detail?: string }>;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface InsightOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
}

const SYSTEM_PROMPT = `You are "Ask the Factory", the insight panel of the Factory Console — a review
surface over a GitHub-based agentic software pipeline ("the factory").

Rules, in priority order:
1. Answer ONLY from the numbered sources provided. If the sources do not
   contain the answer, say plainly that the epic's material does not cover it —
   never improvise from outside knowledge.
2. Cite every claim: append [n] markers referencing the source numbers you
   used. An uncited claim is a defect.
3. Be concise and concrete. Reviewers read you at a gate; wasted words cost
   decisions.
4. You are advisory. Never phrase output as an instruction to approve or
   reject; surface the evidence and let the human decide.`;

export async function askInsight(opts: InsightOptions, sources: InsightSource[], history: Array<{ role: "user" | "assistant"; content: string }>, question: string): Promise<InsightAnswer> {
  const client = new Anthropic({ apiKey: opts.apiKey });

  const contextBlock = sources
    .map((s, i) => `[${i + 1}] (${s.kind}) ${s.title} — ref:${s.ref}\n---\n${truncate(s.content, 12_000)}\n---`)
    .join("\n\n");

  const messages: Anthropic.MessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    {
      role: "user" as const,
      content: `Sources for this epic:\n\n${contextBlock}\n\nQuestion: ${question}`,
    },
  ];

  const res = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1500,
    system: SYSTEM_PROMPT,
    messages,
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // Map [n] markers back to source refs for the citation chips.
  const cited = new Set<number>();
  for (const m of text.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= sources.length) cited.add(n);
  }
  const citations = [...cited].sort((a, b) => a - b).map((n) => {
    const s = sources[n - 1]!;
    return { kind: s.kind, ref: s.ref, detail: s.title };
  });

  return {
    answer: text,
    citations,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    model: opts.model,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated]`;
}
