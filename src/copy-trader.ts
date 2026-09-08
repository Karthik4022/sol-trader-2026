import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  ParsedTransactionWithMeta,
  PublicKey,
} from "@solana/web3.js";
import type { Config } from "./config.js";
import { logger } from "./logger.js";
import { buySmart, priceSmart, sellSmart } from "./actions.js";
import { safetyCheck } from "./safety.js";
import { PaperWallet } from "./paper-wallet.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

interface WalletBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  raw: bigint;
}

/**
 * Copy-trading engine: polls target wallets, detects SOL->token buys from
 * pre/post balances of their token accounts and mirrors them with a size
 * multiplier. (Sells are logged but NOT auto-mirrored to avoid surprises.)
 */
export class CopyTrader {
  private processed = new Set<string>();
  private initializedWallets = new Set<string>();
  private maxProcessed = 5000;
  private stopReq = false;
  onTrade?: (text: string) => void;

  constructor(
    private cfg: Config,
    private conn: Connection,
    private wallet: Keypair
  ) {}

  /** Asks the polling loop to exit after the current round. */
  requestStop(): void {
    this.stopReq = true;
  }

  async run(wallets: PublicKey[]): Promise<void> {
    logger.info("copy", `monitoring ${wallets.map((w) => w.toBase58().slice(0, 8)).join(", ")}`);
    const POLL_MS = 6000;
    while (!this.stopReq) {
      for (const w of wallets) {
        try {
          await this.pollWallet(w);
        } catch (e) {
          logger.warn("copy", `poll ${w.toBase58().slice(0, 8)}… failed: ${(e as Error).message}`);
        }
      }
      await sleep(POLL_MS);
    }
    logger.info("copy", "copy-trader stopped");
  }

  private remember(sig: string): boolean {
    if (this.processed.has(sig)) return false;
    if (this.processed.size > this.maxProcessed) {
      const it = this.processed.values().next().value;
      if (it !== undefined) this.processed.delete(it);
    }
    this.processed.add(sig);
    return true;
  }

  private async pollWallet(wallet: PublicKey): Promise<void> {
    const sigs = await this.conn.getSignaturesForAddress(wallet, { limit: 8 }, "confirmed");
    const walletKey = wallet.toBase58();
    if (!this.initializedWallets.has(walletKey)) {
      for (const s of sigs) this.remember(s.signature);
      this.initializedWallets.add(walletKey);
      logger.info("copy", `${walletKey.slice(0, 8)}… ready; watching new trades`);
      return;
    }
    for (const s of sigs) {
      if (!this.remember(s.signature)) continue;
      if (s.err) continue;
      try {
        const tx = await this.conn.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (!tx || tx.meta?.err) continue;
        const action = this.analyze(tx, wallet);
        if (action?.type === "buy") {
          await this.mirrorBuy(action.mint, action.solSpentLamports);
        } else if (action?.type === "sell") {
          if (this.cfg.copyTradeAutoSell) await this.mirrorSell(action.tokenMint, action.sellPct);
          else logger.info("copy", `${wallet.toBase58().slice(0, 8)}… SOLD ${action.tokenMint.slice(0, 8)}… — auto-sell off`);
        }
      } catch (e) {
        logger.debug("copy", `tx ${s.signature.slice(0, 8)}…: ${(e as Error).message}`);
      }
    }
  }

  /** Detects a meaningful SOL->token buy or token->SOL sell for `wallet`. */
  private analyze(
    tx: ParsedTransactionWithMeta,
    wallet: PublicKey
  ): { type: "buy" | "sell"; mint: string; solSpentLamports: bigint; tokenMint: string; solGainedLamports: bigint; sellPct: number } | null {
    const pre = tx.meta?.preTokenBalances ?? [];
    const post = tx.meta?.postTokenBalances ?? [];
    const owner = wallet.toBase58();
    const own = (b: any) => b.owner === owner;

    let solDelta = 0n;
    const balances = tx.meta?.postBalances ?? [];
    const preBal = tx.meta?.preBalances ?? [];
    const keys = tx.transaction.message.accountKeys as unknown as Array<
      string | { pubkey: string | PublicKey }
    >;
    for (let i = 0; i < balances.length; i++) {
      const k = keys[i];
      if (!k) continue;
      const a = typeof k === "string"
        ? k
        : k.pubkey instanceof PublicKey
          ? k.pubkey.toBase58()
          : String(k.pubkey);
      if (a === owner) solDelta += BigInt(balances[i]) - BigInt(preBal[i] ?? balances[i]);
    }

    const tokenDeltas = new Map<string, bigint>();
    const preAmounts = new Map<string, bigint>();
    for (const b of post) if (own(b)) tokenDeltas.set(b.mint, (tokenDeltas.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
    for (const b of pre) if (own(b)) {
      const amount = BigInt(b.uiTokenAmount.amount);
      tokenDeltas.set(b.mint, (tokenDeltas.get(b.mint) ?? 0n) - amount);
      preAmounts.set(b.mint, (preAmounts.get(b.mint) ?? 0n) + amount);
    }

    let bestBuy: { mint: string; delta: bigint } | null = null;
    let bestSell: { mint: string; delta: bigint } | null = null;
    for (const [mint, delta] of tokenDeltas) {
      if (mint === SOL_MINT) continue;
      if (delta > 0n && (!bestBuy || delta > bestBuy.delta)) bestBuy = { mint, delta };
      if (delta < 0n && (!bestSell || -delta > -bestSell.delta)) bestSell = { mint, delta: -delta };
    }

    if (solDelta < -10_000_000n && bestBuy) {
      // ignore dust buys
      if (solDelta > -50_000_000n && bestBuy.delta < 1_000_000n) return null;
      return { type: "buy", mint: bestBuy.mint, solSpentLamports: -solDelta, tokenMint: bestBuy.mint, solGainedLamports: 0n, sellPct: 0 };
    }
    if (solDelta > 100_000n && bestSell) {
      const before = preAmounts.get(bestSell.mint) ?? bestSell.delta;
      const sellPct = Math.max(1, Math.min(100, Number((bestSell.delta * 10_000n) / before) / 100));
      return { type: "sell", mint: bestSell.mint, solSpentLamports: 0n, tokenMint: bestSell.mint, solGainedLamports: solDelta, sellPct };
    }
    return null;
  }

  private async mirrorBuy(mint: string, solSpentLamports: bigint): Promise<void> {
    const m = new PublicKey(mint);
    const spend = (solSpentLamports * BigInt(Math.round(this.cfg.copyTradeSizeMult * 100))) / 100n;
    const minSol = BigInt(Math.round(this.cfg.copyTradeMinSol * LAMPORTS_PER_SOL));
    if (spend < minSol) {
      logger.debug("copy", `mirror skip: ${(Number(spend) / LAMPORTS_PER_SOL).toFixed(4)} SOL < min`);
      return;
    }
    const safety = await safetyCheck(this.conn, this.cfg, m);
    if (!safety.ok) {
      logger.warn("copy", `safety blocked mirror of ${mint.slice(0, 8)}…: ${safety.reasons.join("; ")}`);
      return;
    }
    if (this.cfg.paperMode) {
      const price = await priceSmart(this.conn, this.cfg, m);
      const r = new PaperWallet(this.cfg.paperFile, this.cfg.paperStartingSol)
        .buy(mint, Number(spend) / LAMPORTS_PER_SOL, price.priceSol);
      logger.info("copy", `PAPER MIRROR BUY ${mint.slice(0, 10)}… ${r.tokens.toPrecision(6)} tokens`);
      this.onTrade?.([
        "🧪 PAPER COPY BUY",
        `Mint: ${mint}`,
        `Spent: ${(Number(spend) / LAMPORTS_PER_SOL).toFixed(4)} virtual SOL`,
        `Received: ${r.tokens.toPrecision(6)} tokens`,
        `Balance: ${r.balance.toFixed(4)} virtual SOL`,
      ].join("\n"));
      return;
    }
    try {
      // buySmart mirrors curve tokens directly on Pump.fun and migrated
      // tokens through Jupiter, so new launches are copy-tradeable too.
      const res = await buySmart(this.conn, this.cfg, this.wallet, m, spend);
      logger.info("copy", `MIRROR BUY ${mint.slice(0, 10)}… ${(Number(spend) / LAMPORTS_PER_SOL).toFixed(3)} SOL -> ${res.signature.slice(0, 12)}…`);
      this.onTrade?.([
        "🟢 COPY BUY EXECUTED",
        `Mint: ${mint}`,
        `Spent: ${(Number(spend) / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
        `Signature: ${res.signature}`,
      ].join("\n"));
    } catch (e) {
      logger.warn("copy", `mirror buy ${mint.slice(0, 8)}… failed (${(e as Error).message.slice(0, 80)})`);
    }
  }

  private async mirrorSell(mint: string, targetSellPct: number): Promise<void> {
    try {
      const sellPct = Math.min(this.cfg.copyTradeSellPct, targetSellPct);
      if (this.cfg.paperMode) {
        const m = new PublicKey(mint);
        const price = await priceSmart(this.conn, this.cfg, m);
        const r = new PaperWallet(this.cfg.paperFile, this.cfg.paperStartingSol)
          .sell(mint, sellPct, price.priceSol);
        logger.info("copy", `PAPER MIRROR SELL ${mint.slice(0, 10)}… +${r.sol.toFixed(4)} virtual SOL`);
        this.onTrade?.([
          "🧪 PAPER COPY SELL",
          `Mint: ${mint}`,
          `Sold: ${sellPct.toFixed(2)}% (matched target)`,
          `Received: ${r.sol.toFixed(4)} virtual SOL`,
          `Balance: ${r.balance.toFixed(4)} virtual SOL`,
        ].join("\n"));
        return;
      }
      const res = await sellSmart(
        this.conn,
        this.cfg,
        this.wallet,
        new PublicKey(mint),
        sellPct
      );
      logger.info("copy", `MIRROR SELL ${mint.slice(0, 10)}… ${sellPct.toFixed(2)}% -> ${res.signature.slice(0, 12)}…`);
      this.onTrade?.([
        "🔴 COPY SELL EXECUTED",
        `Mint: ${mint}`,
        `Sold: ${sellPct.toFixed(2)}% (matched target)`,
        `Signature: ${res.signature}`,
      ].join("\n"));
    } catch (e) {
      logger.warn("copy", `mirror sell ${mint.slice(0, 8)}… failed (${(e as Error).message.slice(0, 80)})`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

