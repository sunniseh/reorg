// NEAR adapters (ROADMAP §3). The only TS package that imports NEAR libraries.
export { NearChainAdapter, OPEN_TASK_GAS, FINALIZE_GAS, type NearChainOptions } from "./near-chain";
export { NearReader, type NearReaderOptions } from "./reader";
export { BurnerWallet, NearConnectWallet, PLAYER_GAS, type BurnerOptions, type KeyStore, type NearConnectOptions } from "./wallets";
export { NearFaucet, type NearFaucetOptions } from "./faucet";
export { crowdKey, crowdPublicKey, NearCrowdSigner, NearDemoOperator, type NearCrowdOptions, type NearOperatorOptions } from "./crowd";
