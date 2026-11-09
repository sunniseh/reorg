// Boss service entry point: `npm run boss` (env vars: see .env.example). Wires the store, the
// NEAR adapter, flavor text, the scheduler and the HTTP API; Ctrl-C stops cleanly.
import { NearChainAdapter } from "@reorg/chain-near";
import { createApi } from "./api";
import { loadEnv } from "./env";
import { NearAiFlavor, TemplateFlavor } from "./flavor";
import { Scheduler, type Logger } from "./scheduler";
import { SqliteStore } from "./store";

const log: Logger = {
  info: (msg, fields) => console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", msg, ...fields })),
  warn: (msg, fields) => console.warn(JSON.stringify({ t: new Date().toISOString(), level: "warn", msg, ...fields })),
};

async function main(): Promise<void> {
  const env = loadEnv();
  const store = new SqliteStore(env.dbPath);
  const chain = new NearChainAdapter({
    rpcUrl: env.rpcUrl,
    ...(env.rpcApiKey ? { rpcHeaders: { "x-api-key": env.rpcApiKey } } : {}),
    contractId: env.contractId,
    bossId: env.bossId,
    bossKey: env.bossKey,
  });

  const info = await chain.getInfo();
  if (info.boss !== env.bossId) throw new Error(`BOSS_ACCOUNT_ID ${env.bossId} is not the contract's boss (${info.boss})`);

  const flavor = env.llm ? new NearAiFlavor(env.llm) : TemplateFlavor;
  const scheduler = new Scheduler({ store, chain, flavor, config: env.scheduler, log });
  const api = createApi({ store, health: () => scheduler.health(), origins: env.origins, network: env.network });
  api.listen(env.port, () =>
    log.info("boss listening", {
      port: env.port,
      network: env.network,
      contract: env.contractId,
      flavor: flavor.source,
      epoch_s: env.scheduler.epochMs / 1000,
    }),
  );

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) process.exit(1); // second Ctrl-C: force
    stopping = true;
    log.info("shutting down", { signal });
    scheduler.stop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await scheduler.run();
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  store.close();
  log.info("stopped");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
