import { Connection } from "@solana/web3.js";
import type { Config } from "./config.js";

/** Builds the Solana Connection. Prefer a private/fast RPC provider. */
export function makeConnection(cfg: Config): Connection {
  const ws = cfg.wsUrl || undefined;
  return new Connection(cfg.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: ws,
    confirmTransactionInitialTimeout: 60_000,
    disableRetryOnRateLimit: false,
  });
}

/**
 * Latest prioritization fee (microlamports per CU) seen on-chain.
 * Used as the compute-unit price for speed-sensitive transactions.
 */
export async function recentPriorityFee(conn: Connection): Promise<number> {
  try {
    const fees = await conn.getRecentPrioritizationFees();
    if (!fees.length) return 0;
    const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => b - a);
    // p75-ish: index at 25% from the top
    const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.25))];
    return Math.max(0, p75);
  } catch {
    return 0;
  }
}

