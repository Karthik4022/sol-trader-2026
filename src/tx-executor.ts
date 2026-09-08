import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { JITO_BLOCK_ENGINE, JITO_TIP_ACCOUNT } from "./constants.js";
import { logger } from "./logger.js";

export interface SendOpts {
  /** Extra tip sent to the Jito block engine tip account (SOL). 0 disables Jito. */
  jitoTipSol?: number;
  /** Base compute-unit price in microlamports/CU (0 = let the RPC pick). */
  computeUnitPrice?: number;
  computeUnitLimit?: number;
}

function addComputeIxs(tx: Transaction, opts: SendOpts): void {
  if (opts.computeUnitLimit && opts.computeUnitLimit > 0) {
    tx.add(
      new TransactionInstruction({
        keys: [],
        programId: new PublicKey("ComputeBudget111111111111111111111111111111"),
        data: Buffer.concat([Buffer.from([2]), uint32(opts.computeUnitLimit)]),
      })
    );
  }
  if (opts.computeUnitPrice && opts.computeUnitPrice > 0) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(opts.computeUnitPrice))));
    tx.add(
      new TransactionInstruction({
        keys: [],
        programId: new PublicKey("ComputeBudget111111111111111111111111111111"),
        data: Buffer.concat([Buffer.from([3]), b]),
      })
    );
  }
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

/**
 * Signs + sends a VersionedTransaction (Jupiter swaps) with retry.
 * Returns the confirmed transaction signature.
 */
export async function sendVersioned(
  conn: Connection,
  tx: VersionedTransaction,
  wallet: Keypair,
  label = "swap"
): Promise<string> {
  tx.sign([wallet]);
  const raw = tx.serialize();
  return broadcast(conn, raw, label);
}

/** Sends a legacy Transaction (pump direct buy, Jito tip path). */
export async function sendLegacy(
  conn: Connection,
  tx: Transaction,
  wallet: Keypair,
  opts: SendOpts,
  label = "tx"
): Promise<string> {
  if (opts.jitoTipSol && opts.jitoTipSol > 0) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: JITO_TIP_ACCOUNT,
        lamports: Math.round(opts.jitoTipSol * LAMPORTS_PER_SOL),
      })
    );
  }
  addComputeIxs(tx, opts);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(wallet);

  if (opts.jitoTipSol && opts.jitoTipSol > 0) {
    // Route through the block engine so the tip actually buys priority.
    return sendJitoBundle([tx.serialize()], label);
  }
  return broadcast(conn, tx.serialize(), label);
}

async function broadcast(conn: Connection, rawTx: Uint8Array, label: string): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sig = await conn.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 0,
      });
      await confirm(conn, sig, label);
      return sig;
    } catch (e) {
      lastErr = e as Error;
      logger.warn("executor", `${label} attempt ${attempt + 1} failed: ${(e as Error).message}`);
      if ((e as Error).message.includes("Transaction simulation failed")) break;
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error(`${label}: send failed`);
}

export async function sendJitoBundle(rawTxs: Uint8Array[], label: string): Promise<string> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "sendBundle",
    params: [rawTxs.map((t) => Buffer.from(t).toString("base64"))],
  };
  const res = await fetch(`${JITO_BLOCK_ENGINE}/api/v1/bundles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!res.ok || !json.result) {
    throw new Error(`Jito bundle failed: ${json.error?.message ?? res.statusText}`);
  }
  logger.info("executor", `${label} sent as Jito bundle ${json.result}`);
  return json.result;
}

async function confirm(conn: Connection, sig: string, label: string): Promise<void> {
  const res = await conn.confirmTransaction(sig, "confirmed");
  if (res.value.err) {
    throw new Error(`${label} ${sig} failed on chain: ${JSON.stringify(res.value.err)}`);
  }
  logger.info("executor", `${label} confirmed: ${sig}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}



