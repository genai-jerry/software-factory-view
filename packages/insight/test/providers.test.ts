import { afterEach, describe, expect, it, vi } from "vitest";
import { askInsight, isInsightProvider, type InsightSource } from "../src/index.js";

/** OpenAI-compatible transport: request shape per provider, parsing, citations. */

const SOURCES: InsightSource[] = [
  { ref: "proposal.md@abc1234", kind: "artifact", title: "proposal", content: "We will add rate limits." },
  { ref: "issue/41", kind: "comment", title: "task #41", content: "Blocked by schema work." },
];

function mockFetch(content: string) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 120, completion_tokens: 30 },
        }),
        { status: 200 },
      );
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("provider guard", () => {
  it("accepts the four providers and nothing else", () => {
    for (const p of ["anthropic", "openai", "grok", "openrouter"]) expect(isInsightProvider(p)).toBe(true);
    expect(isInsightProvider("gemini")).toBe(false);
  });
});

describe("OpenAI-compatible providers", () => {
  it("hits the provider's endpoint with a bearer key and maps the answer + citations", async () => {
    const calls = mockFetch("Rate limits are planned [1], pending the schema [2].");
    const res = await askInsight(
      { provider: "openrouter", apiKey: "sk-or-abc", model: "x-ai/grok-4" },
      SOURCES,
      [],
      "What is planned?",
    );
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-or-abc");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("x-ai/grok-4");
    expect(body.messages[0].role).toBe("system");
    expect(body.max_tokens).toBe(1500);
    expect(res.answer).toContain("Rate limits");
    expect(res.citations.map((c) => c.ref)).toEqual(["proposal.md@abc1234", "issue/41"]);
    expect(res.inputTokens).toBe(120);
    expect(res.outputTokens).toBe(30);
  });

  it("uses max_completion_tokens for OpenAI and max_tokens for Grok", async () => {
    const calls = mockFetch("ok [1]");
    await askInsight({ provider: "openai", apiKey: "sk-x", model: "gpt-5.1" }, SOURCES, [], "q");
    await askInsight({ provider: "grok", apiKey: "xai-x", model: "grok-4" }, SOURCES, [], "q");
    const openaiBody = JSON.parse(calls[0]!.init.body as string);
    const grokBody = JSON.parse(calls[1]!.init.body as string);
    expect(calls[0]!.url).toContain("api.openai.com");
    expect(openaiBody.max_completion_tokens).toBe(1500);
    expect(openaiBody.max_tokens).toBeUndefined();
    expect(calls[1]!.url).toContain("api.x.ai");
    expect(grokBody.max_tokens).toBe(1500);
  });

  it("throws with the provider and status on an error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 })),
    );
    await expect(askInsight({ provider: "openai", apiKey: "bad", model: "gpt-5.1" }, SOURCES, [], "q")).rejects.toThrow(
      /openai 401/,
    );
  });
});
