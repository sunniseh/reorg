/**
 * Boot (roadmap W-01). With a contract configured (VITE_REORG_CONTRACT_ID …) the building is live
 * and "Preview growth" switches to the simulation; without one, the client runs the labeled
 * simulation on its own so the building can be seen with no chain at all.
 */
import { App, type AppOptions } from "./app";
import "./hud/style.css";
import { installCssTokens } from "./theme/tokens";

installCssTokens();

const params = new URLSearchParams(location.search);
// Up to 2,000 holders, so every building state (design §12.2) can be previewed.
const previewSize = Math.max(1, Math.min(100_000, Number(params.get("size")) || 24));
// Review only: `?bankrupt=<seconds>` plays the bankruptcy blackout in the simulated preview. No v1
// source reports bankruptcy (PROTOCOL.md: bankruptcy_empty_tasks is reserved).
const bankrupt = params.get("bankrupt");

async function boot(): Promise<void> {
  const opts: AppOptions = { live: null, wallets: [], previewSize, ...(bankrupt !== null ? { reviewBankruptAfterMs: Math.max(0, Number(bankrupt) || 0) * 1000 } : {}) };
  const env = import.meta.env;
  if (env.VITE_REORG_CONTRACT_ID && params.get("sim") !== "1") {
    const { liveOptions } = await import("./live-boot");
    Object.assign(opts, await liveOptions(env));
  }
  const app = new App(document.getElementById("app")!, opts);
  await app.start();
  if (import.meta.env.DEV) (window as unknown as { __reorg: App }).__reorg = app;
}

boot().catch((e) => {
  console.error(e);
  const stage = document.getElementById("stage");
  if (stage) stage.textContent = "The request has been escalated to HR. Try again in a minute.";
});
