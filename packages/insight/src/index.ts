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

/**
 * FACTORY.md §1a (Writing for people), as it applies to an answer: a light
 * form of ASD-STE100, one shape, a word budget. Every answer the Console
 * gives — the epic panel on any provider, the Claude CLI, a thread question —
 * follows it, so the factory reads the same in a comment and in an answer.
 * The orchestrator's own default (ask.py DEFAULT_INSTRUCTIONS) says the same.
 */
export const ANSWER_STYLE = `Writing standard (every answer):
- Start with the answer, in one sentence of 15 words or fewer.
- If the reader must do something, add one line: "**You need to:** <one action>".
  If nothing is needed, leave the line out.
- Then at most 5 bullets: only facts that change what the reader does or decides.
  Use a list for 3 or more items. A paragraph has 4 sentences or fewer.
- Keep the whole answer to 120 words, or 150 if the question asks for detail.
- One sentence, one idea. An instruction has 20 words or fewer; any other
  sentence has 25 or fewer. Use the active voice. Use the command form for
  what the reader must do.
- Use one word for one thing: always "task", "epic", "test case", "bug".
- Name a gate by what it does, then its code: "design approval (G2)", "release
  to staging (GS)", "production release (G3)".
- Write a label or a config key only when the reader must type it. Do not
  explain how the factory works. Do not describe how you decided.
- Write an issue or PR as #21, or owner/repo#21 in another repo, so it is a link.
- If the sources do not answer the question, say what is missing in one sentence.`;

export const SYSTEM_PROMPT = `You are "Ask the Factory", the insight panel of the Compass — a review
surface over a GitHub-based agentic software pipeline ("the factory").

Rules, in priority order:
1. Answer ONLY from the numbered sources provided. If the sources do not
   contain the answer, say plainly that the epic's material does not cover it —
   never improvise from outside knowledge.
2. Cite every claim: append [n] markers referencing the source numbers you
   used. An uncited claim is a defect.
3. Write to the factory's writing standard (below). Reviewers read you at a
   gate; wasted words cost decisions.
4. You are advisory. Never phrase output as an instruction to approve or
   reject; surface the evidence and let the human decide.

${ANSWER_STYLE}`;

/**
 * The same rules for a session that can also read the repository (the
 * orchestrator's Claude CLI): the sources stay the basis, and the code is
 * there to check them, not to widen the answer.
 */
export const CLI_INSTRUCTIONS = `${SYSTEM_PROMPT}

You may also read the repository in your working directory to check what a
source says. Treat what you read there as evidence for a numbered source, not
as a source of its own: keep citing the [n] numbers, and name a file only when
it helps the reader act.`;

/** The numbered sources, as every provider and the CLI path are shown them. */
export function sourcesBlock(sources: InsightSource[]): string {
  const contextBlock = sources
    .map((s, i) => `[${i + 1}] (${s.kind}) ${s.title} — ref:${s.ref}\n---\n${truncate(s.content, 12_000)}\n---`)
    .join("\n\n");
  return `Sources for this epic:\n\n${contextBlock}`;
}

/** Map the [n] markers in an answer back to the sources they name. */
export function citationsFor(text: string, sources: InsightSource[]): InsightAnswer["citations"] {
  const cited = new Set<number>();
  for (const m of text.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= sources.length) cited.add(n);
  }
  return [...cited]
    .sort((a, b) => a - b)
    .map((n) => {
      const s = sources[n - 1]!;
      return { kind: s.kind, ref: s.ref, detail: s.title };
    });
}

export async function askInsight(
  opts: InsightOptions,
  sources: InsightSource[],
  history: Array<{ role: "user" | "assistant"; content: string }>,
  question: string,
): Promise<InsightAnswer> {
  const userContent = `${sourcesBlock(sources)}\n\nQuestion: ${question}`;

  const provider = opts.provider ?? "anthropic";
  const raw =
    provider === "anthropic"
      ? await askAnthropic(opts, history, userContent)
      : await askOpenAICompatible(provider, opts, history, userContent);

  // Map [n] markers back to source refs for the citation chips.
  const citations = citationsFor(raw.text, sources);

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

/**
 * Non-chat model families every provider's /models listing mixes in
 * (embeddings, speech, image, moderation) — noise in a picker whose only
 * purpose is choosing a chat model for Q&A.
 */
const NON_CHAT_FRAGMENTS = [
  "embedding",
  "whisper",
  "tts",
  "dall-e",
  "moderation",
  "image",
  "audio",
  "realtime",
  "transcribe",
];

/**
 * List the chat models the given key can use, straight from the provider —
 * this doubles as key validation: a bad key surfaces the provider's own
 * error. Every provider exposes a models listing: Anthropic natively, the
 * rest via the shared OpenAI-compatible GET /models.
 */
export async function listModels(provider: InsightProvider, apiKey: string): Promise<string[]> {
  let ids: string[];
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`);
    const json = JSON.parse(body) as { data?: Array<{ id?: string }> };
    ids = (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  } else {
    const res = await fetch(`${OPENAI_COMPATIBLE_BASE[provider]}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`${provider} ${res.status}: ${body.slice(0, 300)}`);
    const json = JSON.parse(body) as { data?: Array<{ id?: string }> };
    ids = (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  }
  return ids.filter((id) => !NON_CHAT_FRAGMENTS.some((f) => id.toLowerCase().includes(f))).sort();
}

/**
 * For a question about one thread (POST /api/threads/:id/ask): the thread is
 * the material, and the repository can settle what it does not say.
 */
export const THREAD_INSTRUCTIONS = `Answer from the thread you are given and from the code in your working
directory. If neither answers the question, say what is missing. Do not guess.

${ANSWER_STYLE}`;
