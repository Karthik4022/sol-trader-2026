import { PublicKey } from "@solana/web3.js";

/** Verified on mainnet (BPFLoaderUpgradeab1e, upgradeable program account). */
export const PUMP_PROGRAM = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

/**
 * Pump.fun on-chain "global" state account. It is a PDA of the Pump.fun
 * program with seed "global". We derive it instead of hard-coding so the
 * code never goes stale if the program is redeployed. Verified: this PDA
 * exists on mainnet and is owned by PUMP_PROGRAM.
 */
export function pumpGlobal(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global", "utf8")],
    PUMP_PROGRAM
  )[0];
}

/** PDA seeds used by the Pump.fun bonding curve. */
export function pumpBondingCurve(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve", "utf8"), mint.toBuffer()],
    PUMP_PROGRAM
  )[0];
}

/** Anchor instruction discriminators of the Pump.fun program. */
export const PUMP_DISCRIMINATOR = {
  CREATE: "181ec828051c0777", // sha256("global:create")[0..8]
  BUY: "66063d1201daebea", // sha256("global:buy")[0..8]
  SELL: "33e685a4017f83ad", // sha256("global:sell")[0..8]
} as const;

/** Verified on mainnet: owner == T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt (Jito tip program). */
export const JITO_TIP_ACCOUNT = new PublicKey(
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"
);

export const JITO_BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf";

export const WRAPPED_SOL = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

export const USDC = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

export const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";

