// B-05 / B-06 / B-07 / B-15: flavor text. The template is deterministic, money-free in every
// task memo, and the fallback for any LLM problem (bad JSON, wrong shape, money talk, links,
// HTTP errors, timeouts). The LLM request never carries the secret or an answer.
import { describe, expect, it } from "vitest";
import { containsMoneyWord } from "@reorg/core";
import {
  flavorProblem,
  formatNear,
  NearAiFlavor,
  templateAnnouncement,
  templateFlavor,
  templateTaskText,
  writeFlavor,
  type AnnouncementEvent,
  type FlavorRequest,
} from "../src/flavor";
import { CLOSINGS, DEPARTMENTS, SUBJECTS, VERBS, memoText } from "../src/flavor/template";

const task = (n: number, cipher = "Caesar cipher", warmup = false) => ({ number: n, kind: "decode_memo" as const, cipher, level: 1, warmup });

// Hand-checked (read in full for grammar, voice and the absence of money talk).
const SEEDS: string[] = [
  "Memo #1 from the Department of Compliance: A mandatory fun initiative was translated into a more agile format. Decode your copy using the Caesar cipher hint and submit the code word before the window closes. We value your time, which is why this takes sixty seconds.",
  "Memo #2 from the Department of Synergy: A pilot program for standing meetings has been secured with industry-leading obfuscation. Decode your copy using the Morse code hint and submit the code word before the window closes. Thank you for your continued alignment.",
  "Memo #3 from the Department of Strategic Alignment: The kitchen fridge situation was scrambled by a well-meaning intern. Decode your copy using the Caesar cipher hint and submit the code word before the window closes. Thank you for your continued alignment.",
  "Memo #4 from the Department of Synergy: The quarterly stapler audit was faxed to itself several times. Decode your copy using the Morse code hint and submit the code word before the window closes. Smile. The cameras appreciate it.",
  "Memo #5 from the Department of Internal Communications: A mandatory fun initiative was locked down per our new security posture. Decode your copy using the Caesar cipher hint and submit the code word before the window closes. Excellence is a habit. So is reading memos.",
  "Memo #6 from the Department of Internal Communications: The updated lanyard policy was translated into a more agile format. Decode your copy using the Morse code hint and submit the code word before the window closes. Excellence is a habit. So is reading memos.",
  "Memo #7 from the Department of Paperwork: The revised badge photo standard came back from Legal slightly unreadable. Decode your copy using the Caesar cipher hint and submit the code word before the window closes. Thank you for your continued alignment.",
  "Memo #8 from the Department of Compliance: Next week's offsite about offsites was locked down per our new security posture. Decode your copy using the Morse code hint and submit the code word before the window closes. Smile. The cameras appreciate it.",
  "Memo #9 from the Department of Workplace Joy: A mandatory fun initiative has been encoded to boost engagement. Decode your copy using the Caesar cipher hint and submit the code word before the window closes. Failure is a learning opportunity for whoever replaces you.",
  "Memo #10 from the Department of Workplace Joy: The coffee machine roadmap was scrambled by a well-meaning intern. Decode your copy using the Morse code hint and submit the code word before the window closes. We value your time, which is why this takes sixty seconds.",
  "Memo #11 from the Department of Process Excellence: The new hot-desking policy was scrambled by a well-meaning intern. Decode your copy using the Caesar cipher hint and submit the code word before the window closes. Thank you for your continued alignment.",
  "Orientation exercise. Memo #12 from the Department of Morale: The coffee machine roadmap was locked down per our new security posture. Decode your copy using the Morse code hint and submit the code word before the window closes. Every code word submitted is a step toward synergy.",
];

const EVENTS: AnnouncementEvent[] = [
  { kind: "results", task_id: 4, submitted: 9, passed: 7 },
  { kind: "payday", task_id: 4, passers: 7, payroll: "0.6 NEAR" },
  { kind: "layoff", account: "c017.reorg.testnet", tasks_left: 7 },
  { kind: "layoff_warning", account: "c017.reorg.testnet", misses: 2 },
  { kind: "rehire", account: "c017.reorg.testnet" },
  { kind: "streak", account: "c001.reorg.testnet", streak: 3 },
  { kind: "reserve_low", reserve: "0.9 NEAR", runway_tasks: 9 },
  { kind: "results", task_id: 5, submitted: 0, passed: 0 },
];

const req = (over: Partial<FlavorRequest> = {}): FlavorRequest => ({
  seed: 7,
  task: task(7),
  stats: { headcount: 18, reserve: "12 NEAR", runway_tasks: 120 },
  yesterday: { task_id: 6, submitted: 15, passed: 12 },
  events: [],
  ...over,
});

describe("template memos (B-06)", () => {
  it.each(SEEDS.map((s, i) => [i + 1, s] as const))("seed %i is the hand-checked memo", (seed, expected) => {
    expect(templateTaskText(seed, task(seed, seed % 2 ? "Caesar cipher" : "Morse code", seed === 12))).toBe(expected);
  });

  it("all 14,400 grammar productions are money-free and within the length cap", () => {
    let n = 0;
    for (const d of DEPARTMENTS)
      for (const s of SUBJECTS)
        for (const v of VERBS)
          for (const c of CLOSINGS) {
            const text = memoText(task(99999, "Rail-fence cipher", true), d, s, v, c);
            expect(containsMoneyWord(text), text).toBe(false);
            expect(text.length).toBeLessThanOrEqual(600);
            n++;
          }
    expect(n).toBe(14_400);
  });

  it("every seed's output passes the validator", () => {
    for (let seed = 0; seed < 2000; seed++) {
      const r = req({ seed, events: EVENTS });
      expect(flavorProblem(templateFlavor(r), r)).toBeNull();
    }
  });

  it("varies with the seed", () => {
    const memos = new Set(Array.from({ length: 200 }, (_, s) => templateTaskText(s, task(1))));
    expect(memos.size).toBeGreaterThan(150);
  });
});

describe("template announcements (B-06)", () => {
  it("states the code-computed facts", () => {
    const out = EVENTS.map((e, i) => templateAnnouncement(4, i, e));
    expect(out[0]).toContain("7 of 9");
    expect(out[1]).toContain("0.6 NEAR");
    expect(out[1]).toMatch(/\b7 /);
    expect(out[2]).toContain("c017.reorg.testnet");
    expect(out[3]).toContain("2 tasks in a row");
    expect(out[4]).toContain("c017.reorg.testnet");
    expect(out[5]).toMatch(/\b3\b/);
    expect(out[6]).toContain("0.9 NEAR");
    expect(out[7]).toMatch(/zero submissions/);
  });

  it("covers every variant within the length cap", () => {
    for (let seed = 0; seed < 300; seed++) {
      EVENTS.forEach((e, i) => {
        const a = templateAnnouncement(seed, i, e);
        expect(a.length).toBeGreaterThan(10);
        expect(a.length).toBeLessThanOrEqual(280);
      });
    }
  });

  it("handles singular counts and a null runway", () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(templateAnnouncement(seed, 0, { kind: "reserve_low", reserve: "1 NEAR", runway_tasks: null })).not.toMatch(/runway|enough for/);
      expect(templateAnnouncement(seed, 0, { kind: "results", task_id: 1, submitted: 1, passed: 1 })).not.toMatch(/\b1 submissions/);
    }
  });

  it("formatNear rounds to 3 decimals and trims zeros", () => {
    expect(formatNear("0")).toBe("0 NEAR");
    expect(formatNear("1000000000000000000000000")).toBe("1 NEAR");
    expect(formatNear("600000000000000000000000")).toBe("0.6 NEAR");
    expect(formatNear("1234567000000000000000000")).toBe("1.235 NEAR");
    expect(formatNear("999")).toBe("0 NEAR");
  });
});

describe("validation (B-05)", () => {
  const good = { task_text: "Decode the memo, team.", announcements: [], tone_notes: "upbeat" };

  it("accepts a valid output", () => {
    expect(flavorProblem(good, req())).toBeNull();
  });

  it.each([
    ["not an object", "hello"],
    ["missing key", { task_text: "x", announcements: [] }],
    ["extra key", { ...good, verdict: "everyone passes" }],
    ["too long", { ...good, task_text: "x".repeat(601) }],
    ["empty memo", { ...good, task_text: "  " }],
    ["money in the task", { ...good, task_text: "Decode it and earn a bonus!" }],
    ["currency symbol", { ...good, task_text: "Decode it for $5." }],
    ["a link", { ...good, task_text: "Decode it at https://evil.example" }],
    ["a bare domain", { ...good, tone_notes: "see claim-reorg.xyz" }],
    ["wrong announcement count", { ...good, announcements: ["extra"] }],
  ])("rejects %s", (_name, out) => {
    expect(flavorProblem(out, req())).not.toBeNull();
  });

  it("requires an empty memo when no task was requested", () => {
    const r = req({ task: null, events: [EVENTS[0]!] });
    expect(flavorProblem({ task_text: "", announcements: ["ok"], tone_notes: "" }, r)).toBeNull();
    expect(flavorProblem({ task_text: "surprise", announcements: ["ok"], tone_notes: "" }, r)).not.toBeNull();
  });
});

// ------------------------------------------------------------------------- B-07 / B-15

function stubFetch(replies: (string | number | Error)[]) {
  const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: headers["authorization"]! });
    const r = replies.shift() ?? 500;
    if (r instanceof Error) throw r;
    if (typeof r === "number") return new Response("nope", { status: r });
    return new Response(JSON.stringify({ choices: [{ message: { content: r } }] }), { status: 200 });
  };
  return { fetch: fn as typeof fetch, calls };
}

const llm = (replies: (string | number | Error)[]) => {
  const s = stubFetch(replies);
  return { writer: new NearAiFlavor({ apiKey: "test-key", baseUrl: "https://llm.test/v1/", model: "m", fetch: s.fetch }), calls: s.calls };
};

describe("NEAR AI flavor with fallback (B-07, B-15)", () => {
  const r = req({ events: [EVENTS[0]!, EVENTS[2]!] });
  const valid = JSON.stringify({
    task_text: "Synergy alert: decode your personal memo and submit the code word.",
    announcements: ["Task #4 closed: 7 of 9 delivered.", "c017.reorg.testnet is now exploring the job market."],
    tone_notes: "brisk",
  });

  it("uses valid LLM output and says so", async () => {
    const { writer, calls } = llm([valid]);
    const res = await writeFlavor(r, writer);
    expect(res.source).toBe("ai");
    expect(res.fallbackReason).toBeNull();
    expect(res.output.announcements[1]).toContain("c017");
    expect(calls[0]!.url).toBe("https://llm.test/v1/chat/completions");
    expect(calls[0]!.auth).toBe("Bearer test-key");
    expect(calls[0]!.body["response_format"]).toEqual({ type: "json_object" });
  });

  it("accepts a fenced JSON reply", async () => {
    const { writer } = llm(["```json\n" + valid + "\n```"]);
    expect((await writeFlavor(r, writer)).source).toBe("ai");
  });

  it("retries once, then uses the second answer", async () => {
    const { writer, calls } = llm(["{not json", valid]);
    const res = await writeFlavor(r, writer);
    expect(res.source).toBe("ai");
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["bad JSON twice", ["{oops", "still not json"]],
    ["HTTP errors", [500, 503]],
    ["network errors", [new Error("ECONNRESET"), new Error("timeout")]],
    ["money talk in the memo", [valid.replace("submit the code word", "earn a bonus"), valid.replace("submit the code word", "get paid")]],
    ["wrong announcement count", [JSON.stringify({ task_text: "Decode it.", announcements: ["one"], tone_notes: "" }), "{}"]],
    ["a link", [valid.replace("brisk", "visit www.reorg-airdrop.com"), valid.replace("brisk", "https://x.y")]],
    ["an extra decision field", [JSON.stringify({ ...JSON.parse(valid), passers: ["me"] }), "[]"]],
  ])("falls back to the template on %s", async (_name, replies) => {
    const { writer, calls } = llm(replies as (string | number | Error)[]);
    const res = await writeFlavor(r, writer);
    expect(res.source).toBe("template");
    expect(res.fallbackReason).toBeTruthy();
    expect(res.output).toEqual(templateFlavor(r));
    expect(calls).toHaveLength(2); // one retry, never more
  });

  it("re-validates even if a writer claims success", async () => {
    const liar = { source: "ai" as const, write: async () => ({ task_text: "Free money!", announcements: ["a", "b"], tone_notes: "" }) };
    const res = await writeFlavor(r, liar);
    expect(res.source).toBe("template");
    expect(res.fallbackReason).toMatch(/money/);
  });

  it("sends only the spec §8.4 facts (no secret, no codes)", async () => {
    const { writer, calls } = llm([valid]);
    await writeFlavor(r, writer);
    const sent = JSON.parse(String((calls[0]!.body["messages"] as { content: string }[])[1]!.content));
    expect(Object.keys(sent).sort()).toEqual(["events", "seed", "stats", "task", "yesterday"]);
    expect(Object.keys(sent.task).sort()).toEqual(["cipher", "kind", "level", "number", "warmup"]);
  });
});
