import Anthropic from "@anthropic-ai/sdk";

/**
 * The insight service (spec 01 §5): grounded, cited, bounded, read-only.
 * It receives an already-assembled context — it holds no credentials of any
 * kind and cannot fetch or write. Context assembly happens in the API layer,
 * bounded to the epic's own surfaces; this module's only power is to call the
 * model and shape a cited answer.
 *
 * Providers: Anthropic natively via its SDK; OpenAI, Grok (xAI) and
 * OpenRouter through the OpenAI-compatible Chat Completions protocol they
 * all share. The grounding rules, citation contract and token accounting are
 * identical across providers — only the transport differs.
 */

export type InsightProvider = "anthropic" | "openai" | "grok" | "openrouter";

export const INSIGHT_PROVIDERS: readonly InsightProvider[] = ["anthropic", "openai", "grok", "openrouter"];

export function isInsightProvider(v: string): v is InsightProvider {
  return (INSIGHT_PROVIDERS as readonly string[]).includes(v);
}

/** Chat Completions endpoints for the OpenAI-compatible providers. */
const OPENAI_COMPATIBLE_BASE: Record<Exclude<InsightProvider, "anthropic">, string> = {
  openai: "https://api.openai.com/v1",
  grok: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

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
  /** Defaults to "anthropic" for existing callers. */
  provider?: InsightProvider;
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

export async function askInsight(
  opts: InsightOptions,
  sources: InsightSource[],
  history: Array<{ role: "user" | "assistant"; content: string }>,
  question: string,
): Promise<InsightAnswer> {
  const contextBlock = sources
    .map((s, i) => `[${i + 1}] (${s.kind}) ${s.title} — ref:${s.ref}\n---\n${truncate(s.content, 12_000)}\n---`)
    .join("\n\n");
  const userContent = `Sources for this epic:\n\n${contextBlock}\n\nQuestion: ${question}`;

  const provider = opts.provider ?? "anthropic";
  const raw =
    provider === "anthropic"
      ? await askAnthropic(opts, history, userContent)
      : await askOpenAICompatible(provider, opts, history, userContent);

  // Map [n] markers back to source refs for the citation chips.
  const cited = new Set<number>();
  for (const m of raw.text.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= sources.length) cited.add(n);
  }
  const citations = [...cited]
    .sort((a, b) => a - b)
    .map((n) => {
      const s = sources[n - 1]!;
      return { kind: s.kind, ref: s.ref, detail: s.title };
    });

  return {
    answer: raw.text,
    citations,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    model: opts.model,
  };
}

interface RawAnswer {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

async function askAnthropic(
  opts: InsightOptions,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userContent: string,
): Promise<RawAnswer> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const messages: Anthropic.MessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: userContent },
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
  return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
}

/**
 * OpenAI-compatible Chat Completions (OpenAI, Grok/xAI, OpenRouter). Kept to
 * plain fetch: one wire shape covers all three, and this module stays free of
 * per-provider SDK dependencies. Newer OpenAI models reject `max_tokens` in
 * favor of `max_completion_tokens`; the other providers accept `max_tokens`.
 */
async function askOpenAICompatible(
  provider: Exclude<InsightProvider, "anthropic">,
  opts: InsightOptions,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userContent: string,
): Promise<RawAnswer> {
  const cap = opts.maxTokens ?? 1500;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: userContent },
    ],
    ...(provider === "openai" ? { max_completion_tokens: cap } : { max_tokens: cap }),
  };
  const res = await fetch(`${OPENAI_COMPATIBLE_BASE[provider]}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(body),
  });
  const textBody = await res.text();
  if (!res.ok) {
    throw new Error(`${provider} ${res.status}: ${textBody.slice(0, 300)}`);
  }
  const json = JSON.parse(textBody) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: json.choices?.[0]?.message?.content ?? "",
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated]`;
}
