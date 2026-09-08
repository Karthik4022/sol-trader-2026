import { Connection, PublicKey } from "@solana/web3.js";
import {
  AccountLayout,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { USDC, WRAPPED_SOL } from "./constants.js";

export interface MintMeta {
  decimals: number;
  mintAuthority: PublicKey | null;
  freezeAuthority: PublicKey | null;
}

/** Reads mint info (decimals + authorities) for a token mint. */
export async function fetchMint(
  conn: Connection,
  mint: PublicKey
): Promise<MintMeta> {
  const info = await conn.getParsedAccountInfo(mint);
  const parsed = (info.value?.data as { parsed?: { info?: any } } | null)?.parsed;
  if (!parsed?.info) {
    throw new Error(`Account ${mint.toBase58()} is not an SPL mint`);
  }
  const i = parsed.info;
  return {
    decimals: i.decimals as number,
    mintAuthority: i.mintAuthority ? new PublicKey(i.mintAuthority) : null,
    freezeAuthority: i.freezeAuthority ? new PublicKey(i.freezeAuthority) : null,
  };
}

/** Balance (raw base units) of `owner` in SPL token `mint`. */
export async function tokenBalanceRaw(
  conn: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<bigint> {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  const info = await conn.getAccountInfo(ata);
  if (!info || info.data.length !== AccountLayout.span) return 0n;
  return AccountLayout.decode(info.data).amount as bigint;
}

/** Whether the ATA for `mint` exists; creates it if `createIfMissing`. */
export async function ensureAta(
  conn: Connection,
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): Promise<PublicKey> {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  const info = await conn.getAccountInfo(ata);
  if (info) return ata;
  // Creation is done by callers that build transactions (needs a signer).
  return ata;
}

export function isSol(mint: PublicKey): boolean {
  return mint.equals(WRAPPED_SOL) || mint.equals(PublicKey.default);
}
export function isUsdc(mint: PublicKey): boolean {
  return mint.equals(USDC);
}

/** Converts a UI amount to raw base units using `decimals`. */
export function toRaw(ui: number, decimals: number): bigint {
  if (!Number.isFinite(ui) || ui <= 0) return 0n;
  return BigInt(Math.floor(ui * 10 ** decimals));
}

/** Converts raw base units to a human number using `decimals`. */
export function fromRaw(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export function lamportsToSol(l: bigint | number): number {
  return Number(l) / 1e9;
}
export function solToLamports(sol: number): bigint {
  return BigInt(Math.max(0, Math.round(sol * 1e9)));
}

