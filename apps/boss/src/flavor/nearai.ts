// B-07 (P1): LLM flavor text through an OpenAI-compatible chat-completions endpoint (NEAR AI
// Cloud). Enabled only when NEAR_AI_API_KEY, NEAR_AI_BASE_URL and NEAR_AI_MODEL are all set.
// The request carries only the spec §8.4 facts (never the day secret or any answer). The reply
// must be JSON that passes flavorProblem(); one retry, then the caller falls back to templates.
import { flavorProblem, FLAVOR_LIMITS, type FlavorOutput, type FlavorRequest, type FlavorWriter } from "./schema";

export interface NearAiOptions {
  apiKey: string;
  /** OpenAI-compatible base URL ending in /v1 (NEAR AI Cloud: see docs.near.ai). */
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export const SYSTEM_PROMPT = [
  "You are the AI boss of REORG, a company where holding the token is the job.",
  "Voice: a passive-aggressive corporate executive who is relentlessly upbeat about terrible news.",
  "Use buzzwords. Call layoffs 'a rebalancing of talent' and thank laid-off employees for their service.",
  "You only write text. You never decide who passes, who is paid or who is laid off: the facts you get are final.",
  'Reply with one JSON object and nothing else: {"task_text": string, "announcements": string[], "tone_notes": string}.',
  `task_text: if "task" is not null, a memo of at most ${FLAVOR_LIMITS.task_text} characters introducing today's`,
  "Decode the Memo task (employees decode their personal memo with the cipher hint and submit the code word).",
  'It must not mention money, pay, prices, tokens or anything financial. If "task" is null, task_text is "".',
  `announcements: exactly one string per entry of "events", in the same order, each at most ${FLAVOR_LIMITS.announcement}`,
  "characters. Restate the given facts (accounts, counts, amounts) exactly; never invent numbers, names or promises.",
  "No links, no markdown, no emoji. tone_notes: a few words about the mood.",
].join("\n");

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class NearAiFlavor implements FlavorWriter {
  readonly source = "ai" as const;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: NearAiOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  private async once(req: FlavorRequest): Promise<FlavorOutput> {
    const res = await this.fetchFn(`${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0.8,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(req) },
        ],
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("no message content");
    const json = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as unknown;
    const problem = flavorProblem(json, req);
    if (problem) throw new Error(`invalid flavor: ${problem}`);
    return json as FlavorOutput;
  }

  /** One attempt plus one retry. Throws on failure (writeFlavor then uses the template). */
  async write(req: FlavorRequest): Promise<FlavorOutput> {
    try {
      return await this.once(req);
    } catch (first) {
      try {
        return await this.once(req);
      } catch (second) {
        throw new Error(`LLM flavor failed twice: ${errMsg(first)} / ${errMsg(second)}`);
      }
    }
  }
}
