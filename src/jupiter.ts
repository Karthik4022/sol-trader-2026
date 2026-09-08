import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Config } from "./config.js";
import { WRAPPED_SOL } from "./constants.js";
import { logger } from "./logger.js";
import { sendVersioned } from "./tx-executor.js";

export interface JupQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: number;
  routePlan: unknown[];
  swapMode: string;
}

export interface SwapResult {
  signature: string;
  outAmount: bigint;
  priceImpactPct: number;
}

type JupBase = "lite-api" | "api";

function baseHost(cfg: Config): { host: string; base: JupBase } {
  if (cfg.jupApiBase.includes("api.jup.ag")) return { host: cfg.jupApiBase, base: "api" };
  return { host: cfg.jupApiBase, base: "lite-api" };
}

function apiHeaders(cfg: Config): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cfg.jupApiKey) h["x-api-key"] = cfg.jupApiKey;
  return h;
}

/**
 * Jupiter Swap API (2026): lite-api.jup.ag/swap/v1 is the free endpoint;
 * the deprecated quote-api.jup.ag/v6 was fully sunset on 2025-10-01.
 */
export async function getQuote(
  cfg: Config,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amountRaw: bigint,
  slippageBps: number
): Promise<JupQuote> {
  const params = new URLSearchParams({
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    amount: amountRaw.toString(),
    slippageBps: String(slippageBps),
  });
  const url = `${baseHost(cfg).host}/quote?${params.toString()}`;
  const res = await fetch(url, { headers: apiHeaders(cfg) });
  const json = (await res.json()) as JupQuote | { error?: string };
  if (!res.ok || !("outAmount" in json)) {
    throw new Error(`Jupiter quote failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function buildSwapTx(
  cfg: Config,
  quote: JupQuote,
  user: PublicKey
): Promise<VersionedTransaction> {
  const url = `${baseHost(cfg).host}/swap`;
  const body: Record<string, unknown> = {
    quoteResponse: quote,
    userPublicKey: user.toBase58(),
    wrapAndUnwrapSol: true,
    useSharedAccounts: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: {
      priorityLevelWithMaxLamports: {
        priorityLevel: cfg.priorityLevel,
        maxLamports: cfg.maxPriorityFeeLamports,
      },
    },
  };
  let res = await fetch(url, {
    method: "POST",
    headers: apiHeaders(cfg),
    body: JSON.stringify(body),
  });
  let json = (await res.json()) as { swapTransaction?: string; error?: string };
  // Some endpoints reject the nested priority object; retry without it.
  if (!res.ok || !json.swapTransaction) {
    delete body.prioritizationFeeLamports;
    res = await fetch(url, {
      method: "POST",
      headers: apiHeaders(cfg),
      body: JSON.stringify(body),
    });
    json = (await res.json()) as { swapTransaction?: string; error?: string };
  }
  if (!res.ok || !json.swapTransaction) {
    throw new Error(`Jupiter swap build failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return VersionedTransaction.deserialize(Buffer.from(json.swapTransaction, "base64"));
}

/** Generic swap via Jupiter. `amountRaw` is in the base unit of the input mint. */
export async function swap(
  conn: Connection,
  cfg: Config,
  wallet: Keypair,
  inputMint: PublicKey,
  outputMint: PublicKey,
  amountRaw: bigint,
  slippageBps: number,
  label = "swap"
): Promise<SwapResult> {
  const quote = await getQuote(cfg, inputMint, outputMint, amountRaw, slippageBps);
  const tx = await buildSwapTx(cfg, quote, wallet.publicKey);
  const signature = await sendVersioned(conn, tx, wallet, label);
  return {
    signature,
    outAmount: BigInt(quote.outAmount),
    priceImpactPct: Number(quote.priceImpactPct ?? 0),
  };
}

/** Swaps SOL (native) into an SPL token. */
export async function buyToken(
  conn: Connection,
  cfg: Config,
  wallet: Keypair,
  mint: PublicKey,
  solLamports: bigint,
  slippagePct?: number
): Promise<SwapResult> {
  const bps = Math.round((slippagePct ?? cfg.slippagePct) * 100);
  return swap(conn, cfg, wallet, WRAPPED_SOL, mint, solLamports, bps, "buy");
}

/** Swaps an SPL token back into SOL. */
export async function sellToken(
  conn: Connection,
  cfg: Config,
  wallet: Keypair,
  mint: PublicKey,
  tokenAmountRaw: bigint,
  slippagePct?: number
): Promise<SwapResult> {
  const bps = Math.round((slippagePct ?? cfg.slippagePct) * 100);
  return swap(conn, cfg, wallet, mint, WRAPPED_SOL, tokenAmountRaw, bps, "sell");
}

/** Swaps an SPL token into USDC (quote-only helper for prices uses SOL). */

/**
 * Market price of one token in SOL (Lamport per base unit is returned as
 * a JS number of SOL). Uses a small real quote so it works for any pair.
 */
export async function priceSolPerToken(
  conn: Connection,
  cfg: Config,
  mint: PublicKey
): Promise<{ priceSol: number; decimals: number }> {
  const mintInfo = await conn.getParsedAccountInfo(mint);
  const decimals =
    ((mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } } | null)
      ?.parsed?.info?.decimals) ?? 9;
  // Ask for exactly one whole token so the arithmetic stays intuitive.
  const units = 10n ** BigInt(Math.min(decimals, 9));
  const quote = await getQuote(cfg, mint, WRAPPED_SOL, units, 500);
  const outLamports = BigInt(quote.outAmount);
  const tokensSold = Number(units) / 10 ** Math.min(decimals, 9); // ~1 for decimals<=9
  const priceSol = Number(outLamports) / 1e9 / Math.max(tokensSold, 1e-12);
  return { priceSol, decimals };
}


