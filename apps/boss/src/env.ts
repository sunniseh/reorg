// B-10: boss configuration from environment variables (.env.example lists every one). Keys and
// secrets come only from the environment. Invalid values fail at startup, not mid-cycle.
import { z } from "zod";
import { DEFAULT_PICKER, parseFixedSchedule, parseLevelSchedule } from "./picker";
import type { SchedulerConfig } from "./scheduler";

const num = (def: number) => z.coerce.number().finite().default(def);
const opt = z
  .string()
  .trim()
  .optional()
  .transform((s) => (s ? s : undefined));

const EnvSchema = z.object({
  NETWORK: z.enum(["sandbox", "testnet"]).default("sandbox"),
  NEAR_RPC_URL: z.string().url(),
  NEAR_RPC_API_KEY: opt,
  REORG_CONTRACT_ID: z.string().min(2),
  BOSS_ACCOUNT_ID: z.string().min(2),
  BOSS_PRIVATE_KEY: z.string().regex(/^ed25519:/, "must be an ed25519:… secret key"),
  BOSS_PORT: num(8787).pipe(z.number().int().min(0).max(65535)),
  BOSS_DB_PATH: z.string().default("boss.sqlite"),
  WEB_ORIGIN: z.string().default(""),
  EPOCH_SECONDS: num(86_400).pipe(z.number().min(1)),
  WINDOW_FRACTION: num(0.75).pipe(z.number().gt(0).max(1)),
  WARMUP_TASKS: num(0).pipe(z.number().int().min(0)),
  WARMUP_WINDOW_SECONDS: num(10).pipe(z.number().min(1)),
  FINALITY_MARGIN_SECONDS: num(3).pipe(z.number().min(0)),
  LOOKAHEAD_TASKS: num(7).pipe(z.number().int().min(0).max(30)),
  LEVEL_MODE: z.enum(["schedule", "auto"]).default("schedule"),
  LEVEL_SCHEDULE: z.string().default(DEFAULT_PICKER.levelSchedule.join(",")),
  PUZZLE_SCHEDULE: z.string().default(""),
  NEAR_AI_API_KEY: opt,
  NEAR_AI_BASE_URL: opt,
  NEAR_AI_MODEL: opt,
  FAUCET_ENABLED: z.enum(["0", "1", "true", "false"]).default("0"),
  FAUCET_ACCOUNT_ID: opt,
  FAUCET_PRIVATE_KEY: opt,
  FAUCET_NEAR_AMOUNT: z.string().regex(/^\d+$/).default("2000000000000000000000000"),
  FAUCET_TOKEN_AMOUNT: z.string().regex(/^\d+$/).default("600000000000000000000000"),
  FAUCET_RATE_LIMIT_PER_IP: num(5).pipe(z.number().int().min(1)),
});

export interface BossEnv {
  network: "sandbox" | "testnet";
  rpcUrl: string;
  rpcApiKey: string | undefined;
  contractId: string;
  bossId: string;
  bossKey: string;
  port: number;
  dbPath: string;
  origins: string[];
  scheduler: SchedulerConfig;
  llm: { apiKey: string; baseUrl: string; model: string } | null;
  /** Demo faucet (D-09); null when off. */
  faucet: { accountId: string; key: string; nativeAmount: bigint; tokenAmount: bigint; perIpPerHour: number } | null;
}

export function loadEnv(env: Record<string, string | undefined> = process.env): BossEnv {
  // Empty strings (the .env.example template) mean "unset".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Never echo values: some of them are keys.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`invalid boss environment:\n  ${problems}`);
  }
  const e = parsed.data;
  const llmVars = [e.NEAR_AI_API_KEY, e.NEAR_AI_BASE_URL, e.NEAR_AI_MODEL];
  if (llmVars.some(Boolean) && !llmVars.every(Boolean)) {
    throw new Error("set all of NEAR_AI_API_KEY, NEAR_AI_BASE_URL and NEAR_AI_MODEL, or none (templates)");
  }
  return {
    network: e.NETWORK,
    rpcUrl: e.NEAR_RPC_URL,
    rpcApiKey: e.NEAR_RPC_API_KEY,
    contractId: e.REORG_CONTRACT_ID,
    bossId: e.BOSS_ACCOUNT_ID,
    bossKey: e.BOSS_PRIVATE_KEY,
    port: e.BOSS_PORT,
    dbPath: e.BOSS_DB_PATH,
    origins: e.WEB_ORIGIN.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    scheduler: {
      epochMs: Math.round(e.EPOCH_SECONDS * 1000),
      windowFraction: e.WINDOW_FRACTION,
      warmupTasks: e.WARMUP_TASKS,
      warmupWindowMs: Math.round(e.WARMUP_WINDOW_SECONDS * 1000),
      finalityMarginMs: Math.round(e.FINALITY_MARGIN_SECONDS * 1000),
      lookahead: e.LOOKAHEAD_TASKS,
      openSlackMs: 3000,
      retryBaseMs: 1000,
      retryMaxMs: 60_000,
      stallAfterAttempts: 5,
      maxWaitMs: 5000,
      picker: {
        ...DEFAULT_PICKER,
        levelMode: e.LEVEL_MODE,
        levelSchedule: parseLevelSchedule(e.LEVEL_SCHEDULE),
        fixedSchedule: parseFixedSchedule(e.PUZZLE_SCHEDULE),
      },
    },
    llm: e.NEAR_AI_API_KEY ? { apiKey: e.NEAR_AI_API_KEY, baseUrl: e.NEAR_AI_BASE_URL!, model: e.NEAR_AI_MODEL! } : null,
    faucet: faucetOf(e),
  };
}

function faucetOf(e: z.infer<typeof EnvSchema>): BossEnv["faucet"] {
  if (e.FAUCET_ENABLED !== "1" && e.FAUCET_ENABLED !== "true") return null;
  if (!e.FAUCET_ACCOUNT_ID || !e.FAUCET_PRIVATE_KEY?.startsWith("ed25519:")) {
    throw new Error("FAUCET_ENABLED needs FAUCET_ACCOUNT_ID and an ed25519 FAUCET_PRIVATE_KEY");
  }
  return {
    accountId: e.FAUCET_ACCOUNT_ID,
    key: e.FAUCET_PRIVATE_KEY,
    nativeAmount: BigInt(e.FAUCET_NEAR_AMOUNT),
    tokenAmount: BigInt(e.FAUCET_TOKEN_AMOUNT),
    perIpPerHour: e.FAUCET_RATE_LIMIT_PER_IP,
  };
}
