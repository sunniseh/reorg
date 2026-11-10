// D-02 / D-08 crowd runner without a chain: a fake boss serving real puzzles, a recording signer and
// operator, fake timers. Checks the seeded plan (who submits, right or wrong answer, when), one
// income deposit per task, claims after the finalize, and the dumper's sale and buy-back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerHashBase64,
  crowdDecision,
  crowdDistribution,
  crowdProfiles,
  deriveCode,
  generatePuzzle,
  type ClaimOutcome,
  type CrowdSigner,
  type DemoOperator,
  type SubmissionView,
  type TaskView,
} from "@reorg/core";
import { CrowdRunner, wrongAnswer, type BossClient, type CurrentTask, type CrowdReader } from "../src/runner";

const SUPPLY = 1_000_000_000n * 10n ** 18n;
const members = crowdProfiles(crowdDistribution(20, SUPPLY, [30000, 10000, 2500, 10]));
const SEED = "test-seed";
const SECRET = new Uint8Array(32).fill(7);
const PARAMS = { family: "decode-memo", cipher: "caesar", level: 1 } as const;
const id = (i: number) => `${members[i]!.name}.crowd.test`;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

function setup(taskId: number, warmup: boolean) {
  const t0 = Date.now();
  let cur: CurrentTask = { task_id: taskId, status: "open", warmup, opens_at: ns(t0), closes_at: ns(t0 + 50_000) };
  const submits: { index: number; at: number; hash: string }[] = [];
  const claims: number[] = [];
  const transfers: { from: number | "operator"; to: string; amount: bigint }[] = [];
  const deposits: bigint[] = [];
  const boss: BossClient = {
    current: async () => cur,
    puzzle: async (wallet) => ({ task_id: cur.task_id, ...generatePuzzle(PARAMS, SECRET, wallet) }),
  };
  const signer: CrowdSigner = {
    accountId: id,
    submit: async (index, _t, hash) => (submits.push({ index, at: Date.now() - t0, hash }), { accepted: true, reason: null }),
    claimSalary: async (index): Promise<ClaimOutcome> => (claims.push(index), { status: "paid", amount: "5" }),
    sendTokens: async (index, to, amount) => void transfers.push({ from: index, to, amount }),
  };
  const operator: DemoOperator = {
    accountId: "operator.test",
    depositIncome: async (amount) => void deposits.push(amount),
    sendTokens: async (to, amount) => void transfers.push({ from: "operator", to, amount }),
  };
  let finalized = false;
  const reader: CrowdReader = {
    getTask: async (t) => ({ id: t, status: finalized ? "finalized" : "open" }) as TaskView,
    getSubmission: async (t, wallet) =>
      ({ task_id: t, account_id: wallet, passed: true, reapply: false, pay: "5", claim: "unclaimed" }) as SubmissionView,
  };
  const runner = new CrowdRunner({ boss, reader, signer, operator, members, seed: SEED, incomePerTask: 7n, pollMs: 1000 });
  const finalize = () => {
    finalized = true;
    cur = { ...cur, status: "finalized" };
  };
  return { runner, submits, claims, transfers, deposits, finalize };
}

beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
afterEach(() => vi.useRealTimers());

describe("CrowdRunner", () => {
  it("submits per the seeded plan: right or wrong answers, inside the window, one deposit", async () => {
    const s = setup(4, false);
    await s.runner.tick();
    await s.runner.tick(); // a second poll plans nothing new
    await vi.advanceTimersByTimeAsync(40_000);
    const plan = members.map((m) => crowdDecision(m, 4, SEED, false));
    const expected = plan.flatMap((d, i) => (d.action === "skip" ? [] : [i]));
    expect(s.submits.map((x) => x.index).sort((a, b) => a - b)).toEqual(expected);
    expect(s.deposits).toEqual([7n]);
    for (const sub of s.submits) {
      const d = plan[sub.index]!;
      const code = deriveCode(SECRET, id(sub.index));
      expect(sub.hash).toBe(answerHashBase64(d.action === "pass" ? code : wrongAnswer(code), id(sub.index)));
      expect(sub.at).toBeGreaterThanOrEqual(Math.floor(d.at * 50_000));
      expect(sub.at).toBeLessThan(0.7 * 50_000 + 1);
    }
    expect(s.runner.stats).toMatchObject({ income: 7n, submitted: expected.length, errors: 0 });
    await s.runner.stop();
  });

  it("claims after the finalize, only for wallets that submitted", async () => {
    const s = setup(4, false);
    await s.runner.tick();
    await vi.advanceTimersByTimeAsync(40_000);
    await s.runner.tick();
    expect(s.claims).toEqual([]);
    s.finalize();
    await s.runner.tick();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(s.claims.sort((a, b) => a - b)).toEqual(s.submits.map((x) => x.index).sort((a, b) => a - b));
    await s.runner.stop();
  });

  it("the dumper sells 12% after submitting and the operator sells it back after the claim", async () => {
    const dumper = members.find((m) => m.profile === "dumper")!;
    const task = Array.from({ length: 40 }, (_, i) => i + 1).find((t) => crowdDecision(dumper, t, SEED, false).dump)!;
    const s = setup(task, false);
    await s.runner.tick();
    await vi.advanceTimersByTimeAsync(40_000);
    const sale = (dumper.amount * 12n) / 100n;
    expect(s.transfers).toEqual([{ from: dumper.index, to: "operator.test", amount: sale }]);
    s.finalize();
    await s.runner.tick();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(s.transfers.at(-1)).toEqual({ from: "operator", to: id(dumper.index), amount: sale });
    await s.runner.stop();
  });

  it("does not dump during warm-up and does nothing after stop", async () => {
    const s = setup(2, true);
    await s.runner.tick();
    await s.runner.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.submits).toEqual([]);
    expect(s.transfers).toEqual([]);
  });
});
