import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type { Config } from "./config.js";
import { PUMP_PROGRAM, pumpBondingCurve } from "./constants.js";
import { buyToken, priceSolPerToken, sellToken } from "./jupiter.js";
import { fetchMint, tokenBalanceRaw } from "./tokens.js";
import { executePumpBuy, executePumpSell } from "./pump-buy.js";
import { recentPriorityFee } from "./rpc.js";
import { safetyCheck } from "./safety.js";
import { logger } from "./logger.js";

export class ActionError extends Error {}

export type TradeSource = "pump" | "jupiter";

export interface CurveState {
  bc: PublicKey;
  vSol: bigint;
  vToken: bigint;
}

/** Rough reserve needed for a valid bonding-curve read (rent floor). */
const CURVE_MIN = 2_000_000_000n;

/**
 * Reads a Pump.fun bonding-curve account. Returns null when the token is
 * NOT still on the curve (migrated / closed / not a pump token).
 * State layout (Anchor): disc[8] | vTokenReserves u64 @8 | vSolReserves u64 @16.
 */
export async function pumpCurveState(
  conn: Connection,
  mint: PublicKey
): Promise<CurveState | null> {
  const bc = pumpBondingCurve(mint);
  try {
    const info = await conn.getAccountInfo(bc, "confirmed");
    if (!info) return null;
    if (!info.owner.equals(PUMP_PROGRAM)) return null;
    if (info.data.length < 32) return null;
    const vToken = info.data.readBigUInt64LE(8);
    const vSol = info.data.readBigUInt64LE(16);
    if (vSol < CURVE_MIN || vToken < CURVE_MIN) return null;
    return { bc, vSol, vToken };
  } catch {
    return null;
  }
}

export interface BuyResult {
  signature: string;
  outRaw: bigint; // token base units received (estimate)
  decimals: number;
  source: TradeSource;
  solSpent: bigint;
}

/**
 * Smart buy: detects whether the token is still on its Pump.fun bonding
 * curve (direct curve buy) or has migrated to open markets (Jupiter swap).
 */
export async function buySmart(
  conn: Connection,
  cfg: Config,
  wallet: Keypair,
  mint: PublicKey,
  solLamports: bigint,
  slippagePct?: number
): Promise<BuyResult> {
  if (solLamports < 1_000_000n) {
    throw new ActionError("minimum buy is 0.001 SOL");
  }
  const balance = await conn.getBalance(wallet.publicKey, "confirmed");
  if (BigInt(balance) < solLamports + 10_000_000n) {
    throw new ActionError(
      `insufficient SOL: need ${(Number(solLamports) / 1e9).toFixed(3)} + fees, have ${(balance / 1e9).toFixed(3)}`
    );
  }
  const slippage = slippagePct ?? cfg.slippagePct;
  const curve = await pumpCurveState(conn, mint);
  if (curve) {
    // Token is still on the bonding curve -> direct Pump.fun buy.
    const cu = await recentPriorityFee(conn);
    const r = await executePumpBuy(conn, wallet, mint, curve.bc, solLamports, slippage, {
      jitoTipSol: cfg.jitoTipSol,
      computeUnitPrice: cu,
      computeUnitLimit: 150_000,
    });
    return {
      signature: r.signature,
      outRaw: r.outEstimate,
      decimals: await mintDecimals(conn, mint),
      source: "pump",
      solSpent: solLamports,
    };
  }
  // Migrated token -> route through Jupiter.
  try {
    const jr = await buyToken(conn, cfg, wallet, mint, solLamports, slippage);
    return {
      signature: jr.signature,
      outRaw: jr.outAmount,
      decimals: await mintDecimals(conn, mint),
      source: "jupiter",
      solSpent: solLamports,
    };
  } catch (e) {
    // Race: token may have just migrated between our two checks.
    const curveNow = await pumpCurveState(conn, mint);
    if (curveNow) {
      const cu = await recentPriorityFee(conn);
      const r = await executePumpBuy(conn, wallet, mint, curveNow.bc, solLamports, slippage, {
        jitoTipSol: cfg.jitoTipSol,
        computeUnitPrice: cu,
        computeUnitLimit: 150_000,
      });
      return {
        signature: r.signature,
        outRaw: r.outEstimate,
        decimals: await mintDecimals(conn, mint),
        source: "pump",
        solSpent: solLamports,
      };
    }
    throw new ActionError(`buy failed on ${mint.toBase58().slice(0, 10)}…: ${(e as Error).message}`);
  }
}

export interface SellResult {
  signature: string;
  outLamports: bigint; // SOL received (estimate)
  soldRaw: bigint;
  decimals: number;
  source: TradeSource;
}

/**
 * Smart sell. `pct` = percentage of the held balance (1-100).
 * Uses the bonding curve directly for curve tokens, Jupiter otherwise.
 */
export async function sellSmart(
  conn: Connection,
  cfg: Config,
  wallet: Keypair,
  mint: PublicKey,
  pct = 100,
  slippagePct?: number
): Promise<SellResult> {
  const held = await tokenBalanceRaw(conn, wallet.publicKey, mint);
  if (held <= 0n) throw new ActionError("you hold 0 of this token");
  const raw = pct >= 100 ? held : (held * BigInt(Math.max(1, Math.min(100, pct)))) / 100n;
  const slippage = slippagePct ?? cfg.slippagePct;
  const curve = await pumpCurveState(conn, mint);
  if (curve) {
    const cu = await recentPriorityFee(conn);
    const r = await executePumpSell(conn, wallet, mint, raw, slippage, {
      jitoTipSol: cfg.jitoTipSol,
      computeUnitPrice: cu,
      computeUnitLimit: 150_000,
    });
    return {
      signature: r.signature,
      outLamports: r.outEstimate,
      soldRaw: raw,
      decimals: await mintDecimals(conn, mint),
      source: "pump",
    };
  }
  try {
    const jr = await sellToken(conn, cfg, wallet, mint, raw, slippage);
    return {
      signature: jr.signature,
      outLamports: jr.outAmount,
      soldRaw: raw,
      decimals: await mintDecimals(conn, mint),
      source: "jupiter",
    };
  } catch (e) {
    const curveNow = await pumpCurveState(conn, mint);
    if (curveNow) {
      const cu = await recentPriorityFee(conn);
      const r = await executePumpSell(conn, wallet, mint, raw, slippage, {
        jitoTipSol: cfg.jitoTipSol,
        computeUnitPrice: cu,
        computeUnitLimit: 150_000,
      });
      return {
        signature: r.signature,
        outLamports: r.outEstimate,
        soldRaw: raw,
        decimals: await mintDecimals(conn, mint),
        source: "pump",
      };
    }
    throw new ActionError(`sell failed: ${(e as Error).message}`);
  }
}

export interface PriceInfo {
  priceSol: number;
  decimals: number;
  source: "curve" | "jupiter";
}

/** Price of one token in SOL (curve math or live Jupiter quote). */
export async function priceSmart(
  conn: Connection,
  cfg: Config,
  mint: PublicKey
): Promise<PriceInfo> {
  const curve = await pumpCurveState(conn, mint);
  if (curve) {
    // Marginal price on the constant-product curve: SOL per token = vSol/vToken.
    return {
      priceSol: Number(curve.vSol) / Number(curve.vToken),
      decimals: await mintDecimals(conn, mint),
      source: "curve",
    };
  }
  const jp = await priceSolPerToken(conn, cfg, mint);
  return { priceSol: jp.priceSol, decimals: jp.decimals, source: "jupiter" };
}

/** Runs the configured safety filters; throws ActionError when blocked. */
export async function requireSafety(
  conn: Connection,
  cfg: Config,
  mint: PublicKey
): Promise<void> {
  const r = await safetyCheck(conn, cfg, mint);
  if (!r.ok) {
    throw new ActionError(`safety filters blocked: ${r.reasons.join(" | ")}`);
  }
}

export function toMint(v: string): PublicKey {
  try {
    return new PublicKey(v);
  } catch {
    throw new ActionError(`invalid mint address: "${v}"`);
  }
}

export function solAmount(v: string): bigint {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ActionError(`invalid SOL amount: "${v}"`);
  return BigInt(Math.round(n * LAMPORTS_PER_SOL));
}

export function uiAmount(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ActionError(`invalid amount: "${v}"`);
  return n;
}

export function pctAmount(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100) {
    throw new ActionError(`percent must be 1..100, got "${v}"`);
  }
  return n;
}

async function mintDecimals(conn: Connection, mint: PublicKey, fallback = 6): Promise<number> {
  try {
    const m = await fetchMint(conn, mint);
    return m.decimals;
  } catch {
    return fallback;
  }
}
