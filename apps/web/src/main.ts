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
const previewSize = Math.max(1, Math.min(400, Number(params.get("size")) || 24));

async function boot(): Promise<void> {
  const opts: AppOptions = { live: null, wallets: [], previewSize };
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
