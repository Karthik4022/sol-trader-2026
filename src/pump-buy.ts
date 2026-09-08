import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  PUMP_DISCRIMINATOR,
  PUMP_PROGRAM,
  pumpBondingCurve,
  pumpGlobal,
} from "./constants.js";
import { logger } from "./logger.js";
import type { SendOpts } from "./tx-executor.js";
import { sendLegacy } from "./tx-executor.js";

const SYSTEM_PROGRAM_ID = SystemProgram.programId;

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function disc(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

/**
 * Estimated token output for a Pump.fun bonding-curve buy.
 * BondingCurve account layout (Pump.fun, Anchor):
 *   0..8   discriminator
 *   8..16  virtualTokenReserves (u64)
 *   16..24 virtualSolReserves    (u64)
 *   24..32 tokenTotalSupply      (u64)
 */
export async function estimatePumpOut(
  conn: Connection,
  bondingCurve: PublicKey,
  inputAmount: bigint,
  isSell = false
): Promise<{ out: bigint; reservesOk: boolean }> {
  try {
    const info = await conn.getAccountInfo(bondingCurve);
    if (!info || info.data.length < 32) return { out: 1n, reservesOk: false };
    const vToken = info.data.readBigUInt64LE(8);
    const vSol = info.data.readBigUInt64LE(16);
    if (vSol <= 0n || vToken <= 0n) return { out: 1n, reservesOk: false };
    // bonding-curve constant product, then the protocol takes ~1%
    const feeBps = 100n;
    const gross = isSell
      ? (vSol * inputAmount) / (vToken + inputAmount)
      : (vToken * inputAmount) / (vSol + inputAmount);
    const out = gross - (gross * feeBps) / 10000n;
    return { out: out > 0n ? out : 1n, reservesOk: true };
  } catch {
    return { out: 1n, reservesOk: false };
  }
}

/**
 * Builds a direct Pump.fun buy transaction (the way the fast sniper bots
 * do it) with the bonding-curve ATA created in the same tx when missing.
 *
 * @param solInLamports  amount of SOL to spend
 * @param minOut         minimum token output; pass estimate*(1-slippage)
 */
export async function buildPumpBuyTx(
  conn: Connection,
  wallet: Keypair,
  mint: PublicKey,
  solInLamports: bigint,
  minOut: bigint,
  createAta = true
): Promise<Transaction> {
  const user = wallet.publicKey;
  const bondingCurve = pumpBondingCurve(mint);
  const curveAta = await getAssociatedTokenAddress(mint, bondingCurve, true);
  const userAta = await getAssociatedTokenAddress(mint, user, true);

  const tx = new Transaction();
  if (createAta) {
    const existing = await conn.getAccountInfo(userAta);
    if (!existing) {
      tx.add(
        createAssociatedTokenAccountInstruction(user, userAta, user, mint)
      );
    }
  }

  const keys = [
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: curveAta, isSigner: false, isWritable: true },
    { pubkey: userAta, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: false },
    { pubkey: pumpGlobal(), isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    {
      pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  const data = Buffer.concat([
    disc(PUMP_DISCRIMINATOR.BUY),
    u64le(solInLamports),
    u64le(minOut),
  ]);
  tx.add(new TransactionInstruction({ keys, programId: PUMP_PROGRAM, data }));
  return tx;
}

/** Builds a direct Pump.fun sell transaction (bonding-curve exit). */
export async function buildPumpSellTx(
  _conn: Connection,
  wallet: Keypair,
  mint: PublicKey,
  tokenAmountIn: bigint,
  minSolOut: bigint,
  userAta?: PublicKey
): Promise<Transaction> {
  const user = wallet.publicKey;
  const bondingCurve = pumpBondingCurve(mint);
  const curveAta = await getAssociatedTokenAddress(mint, bondingCurve, true);
  const ata = userAta ?? (await getAssociatedTokenAddress(mint, user, true));

  const tx = new Transaction();
  const keys = [
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: curveAta, isSigner: false, isWritable: true },
    { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: false },
    { pubkey: pumpGlobal(), isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    {
      pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([
    disc(PUMP_DISCRIMINATOR.SELL),
    u64le(tokenAmountIn),
    u64le(minSolOut),
  ]);
  tx.add(new TransactionInstruction({ keys, programId: PUMP_PROGRAM, data }));
  return tx;
}

/**
 * Executes a direct Pump.fun buy.
 * Returns { signature, out, minOut } or throws.
 */
export async function executePumpBuy(
  conn: Connection,
  wallet: Keypair,
  mint: PublicKey,
  bondingCurve: PublicKey,
  solInLamports: bigint,
  slippagePct: number,
  sendOpts: SendOpts
): Promise<{ signature: string; minOut: bigint; outEstimate: bigint }> {
  const est = await estimatePumpOut(conn, bondingCurve, solInLamports, false);
  const minOut =
    est.reservesOk && est.out > 1n
      ? (est.out * BigInt(Math.round(10000 - slippagePct * 100))) / 10000n
      : 1n;
  const tx = await buildPumpBuyTx(conn, wallet, mint, solInLamports, minOut);
  const signature = await sendLegacy(conn, tx, wallet, sendOpts, "pump-buy");
  logger.info(
    "pump-buy",
    `${mint.toBase58().slice(0, 10)}… bought ${Number(minOut)}+ (est ${est.out}) tokens for ${Number(solInLamports) / 1e9} SOL`
  );
  return { signature, minOut, outEstimate: est.out };
}

/** Executes a direct Pump.fun sell of `tokenAmountIn` raw tokens. */
export async function executePumpSell(
  conn: Connection,
  wallet: Keypair,
  mint: PublicKey,
  tokenAmountIn: bigint,
  slippagePct: number,
  sendOpts: SendOpts
): Promise<{ signature: string; outEstimate: bigint }> {
  // Slippage-protect against the price dropping during the tx (~1% base)
  const bondingCurve = pumpBondingCurve(mint);
  const est = await estimatePumpOut(conn, bondingCurve, tokenAmountIn, true);
  const minSol =
    est.reservesOk
      ? (est.out * BigInt(Math.round(10000 - slippagePct * 100))) / 10000n
      : 0n;
  const tx = await buildPumpSellTx(conn, wallet, mint, tokenAmountIn, minSol);
  const signature = await sendLegacy(conn, tx, wallet, sendOpts, "pump-sell");
  logger.info(
    "pump-sell",
    `${mint.toBase58().slice(0, 10)}… sold ${Number(tokenAmountIn)} raw (est ${est.out} lamports) for ${minSol}+ lamports`
  );
  return { signature, outEstimate: est.out };
}



