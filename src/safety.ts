import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import type { Config } from "./config.js";
import { pumpBondingCurve } from "./constants.js";
import { fetchMint } from "./tokens.js";

export interface SafetyResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Lightweight pre-trade filters that run fully on-chain (no paid APIs):
 *  - mint/freeze authority present?
 *  - top holder concentration
 * These are fast heuristics, not a guarantee against rugs.
 */
export async function safetyCheck(
  conn: Connection,
  cfg: Config,
  mint: PublicKey
): Promise<SafetyResult> {
  const reasons: string[] = [];
  const { safety } = cfg;
  try {
    const mintMeta = await fetchMint(conn, mint);
    if (!safety.allowMintAuthority && mintMeta.mintAuthority) {
      reasons.push(`mint authority still set (${mintMeta.mintAuthority.toBase58().slice(0, 8)}…)`);
    }
    if (!safety.allowFreezeAuthority && mintMeta.freezeAuthority) {
      reasons.push("freeze authority still set");
    }
    if (safety.maxHolderPct > 0) {
      const [supply, largest] = await Promise.all([
        conn.getTokenSupply(mint),
        conn.getTokenLargestAccounts(mint),
      ]);
      if (largest.value.length > 0) {
        // Exclude the Pump.fun bonding-curve ATA: it holds the liquidity
        // reserves (most of supply on fresh launches), not a real holder.
        const curveAta = await getAssociatedTokenAddress(
          mint,
          pumpBondingCurve(mint),
          true
        ).catch(() => null);
        const holders = largest.value.filter(
          (a) => !(curveAta && a.address.equals(curveAta))
        );
        if (holders.length > 0) {
          const total = BigInt(supply.value.amount ?? 0);
          const top = BigInt(holders[0].amount ?? 0);
          const pct = total > 0n ? (Number(top) / Number(total)) * 100 : 100;
          if (pct > safety.maxHolderPct) {
            reasons.push(`top holder owns ${pct.toFixed(1)}% (>${safety.maxHolderPct}%)`);
          }
        }
      }
    }
  } catch (e) {
    reasons.push(`safety check error: ${(e as Error).message}`);
  }
  return { ok: reasons.length === 0, reasons };
}


