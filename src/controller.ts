import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type { Config } from "./config.js";
import { ensureDataDirs } from "./config.js";
import { makeConnection } from "./rpc.js";
import { activeWalletLabel, hasWalletFile, loadKeypair, toPublicKey } from "./wallet.js";
import {
  buySmart,
  priceSmart,
  pctAmount,
  requireSafety,
  sellSmart,
  solAmount,
  toMint,
} from "./actions.js";
import { fromRaw, lamportsToSol, tokenBalanceRaw } from "./tokens.js";
import type { Order, OrderKind } from "./limit-order.js";
import { LimitOrderEngine, OrderStore, makeOrder } from "./limit-order.js";
import type { PumpToken } from "./sniper.js";
import { Sniper } from "./sniper.js";
import { CopyTrader } from "./copy-trader.js";
import { logger } from "./logger.js";
import { PaperWallet } from "./paper-wallet.js";

/** User-facing command error (printed to CLI stderr / Telegram chat). */
export class CmdError extends Error {}

/* ------------------------------------------------------------------ */
/* Number formatting helpers                                           */
/* ------------------------------------------------------------------ */

/** Human price: fixed decimals for readable ranges, exponential for dust. */
export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return "n/a";
  if (p === 0) return "0";
  if (p >= 1000) return p.toFixed(0);
  if (p >= 1) return p.toFixed(4);
  if (p >= 1e-4) return p.toFixed(6);
  return p.toExponential(4);
}

/** Human token amount: no silly trailing zeros, 6 significant digits. */
export function fmtAmount(ui: number): string {
  if (!Number.isFinite(ui)) return "n/a";
  const abs = Math.abs(ui);
  let s: string;
  if (abs === 0) s = "0";
  else if (abs >= 1e9) s = ui.toExponential(4);
  else if (abs >= 1) s = ui.toFixed(4);
  else if (abs >= 1e-4) s = ui.toFixed(6);
  else s = ui.toExponential(4);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** Compact SOL balance text. */
export function fmtSol(lamports: number | bigint): string {
  const sol = lamportsToSol(lamports);
  if (!Number.isFinite(sol)) return "n/a";
  if (sol >= 1000) return `${sol.toFixed(2)} SOL`;
  if (sol >= 0.01) return `${sol.toFixed(4)} SOL`;
  return `${sol.toExponential(3)} SOL`;
}

export function shortKey(b58: string, keep = 4): string {
  if (b58.length <= keep * 2 + 1) return b58;
  return `${b58.slice(0, keep)}…${b58.slice(-keep)}`;
}

/* ------------------------------------------------------------------ */
/* App: single shared facade for CLI and Telegram                      */
/* ------------------------------------------------------------------ */

export class App {
  readonly cfg: Config;
  private _conn: Connection | null = null;
  private _wallet: Keypair | null = null;

  private _sniper: Sniper | null = null;
  private _copy: CopyTrader | null = null;
  private _orderEngine: LimitOrderEngine | null = null;
  private _ordersRunning = false;

  /** Event sink. Telegram sets it to push trade/order alerts to chats. */
  onEvent?: (text: string) => void;

  constructor(cfg: Config) {
    this.cfg = cfg;
    ensureDataDirs(cfg);
  }

  /* ------------------------- infrastructure ------------------------ */

  get conn(): Connection {
    if (!this._conn) this._conn = makeConnection(this.cfg);
    return this._conn;
  }

  get wallet(): Keypair {
    if (!this._wallet) this._wallet = loadKeypair(this.cfg.rootDir, this.cfg.walletPrivateKey);
    return this._wallet;
  }

  hasWallet(): boolean {
    if (this.cfg.walletPrivateKey) return true;
    return hasWalletFile(this.cfg.rootDir);
  }

  /** e.g. "main (9Jh…zQp)" for file-backed wallets, or the bare key when env-configured. */
  private get walletLabel(): string {
    if (!this.hasWallet()) return "not configured";
    if (this.cfg.walletPrivateKey) return shortKey(this.wallet.publicKey.toBase58());
    const label = activeWalletLabel(this.cfg.rootDir);
    return `${label} (${shortKey(this.wallet.publicKey.toBase58())})`;
  }

  private emit(text: string): void {
    this.onEvent?.(text);
  }

  /* --------------------------- trades ------------------------------ */

  async buy(mintStr: string, solStr?: string): Promise<string> {
    const mint = toMint(mintStr);
    const lamports = solStr
      ? solAmount(solStr)
      : BigInt(this.cfg.snipeBudgetLamports);
    if (this.cfg.paperMode) {
      const p = await priceSmart(this.conn, this.cfg, mint);
      const sol = lamportsToSol(lamports);
      const r = this.paper.buy(mint.toBase58(), sol, p.priceSol);
      return `PAPER BUY OK\nmint   ${mint.toBase58()}\nspent  ${sol} virtual SOL\ngot    ${fmtAmount(r.tokens)} tokens\nbalance ${r.balance.toFixed(4)} virtual SOL`;
    }
    await requireSafety(this.conn, this.cfg, mint);
    const r = await buySmart(this.conn, this.cfg, this.wallet, mint, lamports);
    const out = fromRaw(r.outRaw, r.decimals);
    const price = r.outRaw > 0n
      ? lamportsToSol(r.solSpent) / Math.max(Number(out), 1e-15)
      : 0;
    return [
      `BUY OK`,
      `mint   ${mint.toBase58()}`,
      `spent  ${fmtSol(r.solSpent)} (source: ${r.source})`,
      `got    ${fmtAmount(out)} tokens`,
      `~price ${fmtPrice(price)} SOL/token`,
      `sig    ${r.signature}`,
    ].join("\n");
  }

  async sell(mintStr: string, pctStr?: string): Promise<string> {
    const mint = toMint(mintStr);
    const pct = pctStr === undefined ? 100 : pctAmount(pctStr);
    if (this.cfg.paperMode) {
      const p = await priceSmart(this.conn, this.cfg, mint);
      const r = this.paper.sell(mint.toBase58(), pct, p.priceSol);
      return `PAPER SELL OK (${pct}%)\nmint   ${mint.toBase58()}\nsold   ${fmtAmount(r.tokens)} tokens\ngot    ${r.sol.toFixed(6)} virtual SOL\nbalance ${r.balance.toFixed(4)} virtual SOL`;
    }
    const r = await sellSmart(this.conn, this.cfg, this.wallet, mint, pct);
    return [
      `SELL OK (${pct}%)`,
      `mint   ${mint.toBase58()}`,
      `sold   ${fmtAmount(fromRaw(r.soldRaw, r.decimals))} tokens`,
      `got    ~${fmtSol(r.outLamports)} (source: ${r.source})`,
      `sig    ${r.signature}`,
    ].join("\n");
  }

  async price(mintStr: string): Promise<string> {
    const mint = toMint(mintStr);
    const p = await priceSmart(this.conn, this.cfg, mint);
    return [
      `PRICE ${mint.toBase58()}`,
      `1 token = ${fmtPrice(p.priceSol)} SOL`,
      `decimals ${p.decimals} (source: ${p.source})`,
    ].join("\n");
  }

  async balance(address?: string): Promise<string> {
    if (this.cfg.paperMode && !address) return `paper wallet\nbalance ${this.paper.balance().toFixed(4)} virtual SOL`;
    const owner = address ? toPublicKey(address) : this.wallet.publicKey;
    const bal = await this.conn.getBalance(owner, "confirmed");
    return `${owner.toBase58()}\nbalance ${fmtSol(bal)}`;
  }

  walletAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  async status(): Promise<string> {
    const lines = [
      `wallet    ${this.walletLabel}`,
      `mode      ${this.cfg.paperMode ? "PAPER (no real transactions)" : "REAL"}`,
      `rpc       ${this.cfg.rpcUrl}`,
      `priority  ${this.cfg.priorityLevel} (max ${fmtSol(this.cfg.maxPriorityFeeLamports)})`,
      `jito tip  ${this.cfg.jitoTipSol > 0 ? `${this.cfg.jitoTipSol} SOL` : "off"}`,
      `slippage  ${this.cfg.slippagePct}%`,
      `sniper    ${this.sniperStatus()}`,
      `copy      ${this.copyStatus()}`,
      `orders    ${this.ordersStatus()}`,
    ];
    if (this.cfg.paperMode) {
      lines.splice(2, 0, this.paper.summary());
    } else if (this.hasWallet()) {
      const bal = await this.conn.getBalance(this.wallet.publicKey, "confirmed");
      lines[0] = `wallet    ${this.wallet.publicKey.toBase58()}`;
      lines.splice(1, 0, `balance   ${fmtSol(bal)}`);
    }
    lines.push(
      `telegram  ${
        this.cfg.tgBotToken
          ? "configured"
          : "not configured (set TG_BOT_TOKEN)"
      }`
    );
    return lines.join("\n");
  }

  /* --------------------------- sniper ----------------------------- */

  startSniper(budgetSol?: number): string {
    if (this._sniper && !this._sniper.isStopped) {
      throw new CmdError("sniper is already running (stop it first)");
    }
    if (budgetSol !== undefined && (!Number.isFinite(budgetSol) || budgetSol <= 0)) {
      throw new CmdError(`snipe budget must be > 0 SOL, got "${budgetSol}"`);
    }
    const s = new Sniper(this.cfg, this.conn, this.wallet);
    if (budgetSol !== undefined) s.budgetOverrideSol = budgetSol;
    s.start({
      onToken: (t) => this.emit(this.snipeFilledText(t)),
      onError: (e) => logger.warn("sniper", `feed error: ${e.message}`),
    });
    this._sniper = s;
    const feed = this.cfg.sniperFeed === 1 ? "PumpPortal" : "RPC logs";
    return `sniper ON (feed: ${feed}, budget ${
      budgetSol !== undefined ? budgetSol : lamportsToSol(this.cfg.snipeBudgetLamports)
    } SOL per buy) — watching for new launches…`;
  }

  stopSniper(): string {
    if (this._sniper && !this._sniper.isStopped) {
      this._sniper.stop();
    }
    this._sniper = null;
    return "sniper OFF";
  }

  sniperStatus(): string {
    if (this._sniper && !this._sniper.isStopped) {
      const feed = this.cfg.sniperFeed === 1 ? "PumpPortal" : "RPC logs";
      return `ON (${feed}, ~${lamportsToSol(this.cfg.snipeBudgetLamports)} SOL/buy)`;
    }
    return "OFF";
  }

  snipeFilledText(t: PumpToken): string {
    const sym = t.symbol ? ` $${t.symbol}` : "";
    return [
      `SNIPER BUY${sym}`,
      `mint    ${t.mint.toBase58()}`,
      `sig     ${t.signature}`,
      `budget  ~${lamportsToSol(this.cfg.snipeBudgetLamports).toFixed(4)} SOL`,
    ].join("\n");
  }


  /* -------------------------- copy trader -------------------------- */

  startCopy(): string {
    if (this._copy) throw new CmdError("copy trader is already running (stop it first)");
    const wallets = this.copyWallets();
    if (wallets.length === 0) {
      throw new CmdError(
        "No copy wallet configured. Open Copy Trade and send the trader's public wallet address first."
      );
    }
    const c = new CopyTrader(this.cfg, this.conn, this.wallet);
    c.onTrade = (text) => this.emit(text);
    this._copy = c;
    void c.run(wallets).catch((e) => logger.error("copy", `engine crashed: ${e.message}`));
    return `copy trader ON — mirroring ${wallets.length} wallet(s) at ${this.cfg.copyTradeSizeMult}×`;
  }

  stopCopy(): string {
    if (this._copy) this._copy.requestStop();
    this._copy = null;
    return "copy trader OFF (stops after the current poll round)";
  }

  copyStatus(): string {
    if (!this._copy) return "OFF";
    return `ON (${this.cfg.copyTradeWallets.length} wallet(s), ${this.cfg.copyTradeSizeMult}×)`;
  }

  copyWallets(): PublicKey[] {
    const out: PublicKey[] = [];
    for (const raw of this.cfg.copyTradeWallets) {
      try {
        out.push(toPublicKey(raw));
      } catch {
        logger.warn("copy", `skipping invalid COPY_TRADE_WALLETS entry "${raw}"`);
      }
    }
    return out;
  }

  /* ---------------------------- orders ----------------------------- */

  startOrderEngine(): string {
    if (this.cfg.paperMode) {
      throw new CmdError("paper order engine is not enabled yet; switch to REAL mode for live orders");
    }
    if (this._orderEngine) {
      throw new CmdError("order engine is already running (stop it first)");
    }
    if (!this.hasWallet()) {
      throw new CmdError("no wallet configured — run `wallet new` or set WALLET_PRIVATE_KEY");
    }
    const store = new OrderStore(this.orderFile());
    const eng = new LimitOrderEngine(this.cfg, this.conn, this.wallet, store);
    eng.onFill = (o) => this.emit(this.orderFillText(o));
    this._orderEngine = eng;
    void eng.run().catch((e) => logger.error("orders", `engine crashed: ${e.message}`));
    const open = store.load().filter((o) => o.status === "open").length;
    return `order engine ON (poll ${this.cfg.orderPollMs} ms) — ${open} open order(s)`;
  }

  stopOrderEngine(): string {
    if (this._orderEngine) this._orderEngine.requestStop();
    this._orderEngine = null;
    return "order engine OFF (stops after the current tick)";
  }

  ordersStatus(): string {
    const open = this.loadOrders().filter((o) => o.status === "open");
    if (open.length === 0) {
      return `${this._orderEngine ? "engine ON" : "engine OFF"} — no open orders`;
    }
    const byKind = new Map<OrderKind, number>();
    for (const o of open) byKind.set(o.kind, (byKind.get(o.kind) ?? 0) + 1);
    const summary = [...byKind.entries()].map(([k, n]) => `${k} ${n}`).join(", ");
    return `${this._orderEngine ? "engine ON" : "engine OFF"} — ${open.length} open (${summary})`;
  }

  async orderAdd(
    kindRaw: string,
    mintStr: string,
    triggerStr: string,
    sizeStr?: string
  ): Promise<string> {
    const kind = kindRaw.trim().toLowerCase() as OrderKind;
    if (!ORDER_KINDS.includes(kind)) {
      throw new CmdError(`order kind must be one of: ${ORDER_KINDS.join(" | ")}`);
    }
    const trigger = Number(triggerStr);
    if (!Number.isFinite(trigger) || trigger <= 0) {
      throw new CmdError(`trigger price must be > 0 SOL per token, got "${triggerStr}"`);
    }
    const mint = toMint(mintStr);
    let solLamports: bigint | undefined;
    let tokenAmountRaw: bigint | undefined;
    let sizeNote: string;
    if (kind === "buy-limit") {
      solLamports = sizeStr === undefined ? BigInt(this.cfg.snipeBudgetLamports) : solAmount(sizeStr);
      sizeNote = fmtSol(solLamports);
    } else {
      // Sell side needs current holdings to derive the raw amount.
      const held = await tokenBalanceRaw(this.conn, this.wallet.publicKey, mint);
      if (held <= 0n) throw new CmdError("you hold 0 of this token — nothing to protect");
      const pct = sizeStr === undefined ? 100 : pctAmount(sizeStr.replace("%", "").trim());
      tokenAmountRaw = pct >= 100 ? held : (held * BigInt(pct)) / 100n;
      sizeNote = `${pct}% of holdings`;
    }
    const order = makeOrder(kind, mint, trigger, solLamports, tokenAmountRaw);
    const store = new OrderStore(this.orderFile());
    store.save([...store.load(), order]);
    return [
      `ORDER ${order.id} OPEN`,
      `kind     ${order.kind}`,
      `mint     ${order.mint}`,
      `trigger  ${fmtPrice(order.triggerPriceSol)} SOL/token`,
      `size     ${sizeNote}`,
      `engine   ${
        this._orderEngine ? "running — fills live" : "stopped — start with `order run` or `/orders on`"
      }`,
    ].join("\n");
  }

  orderList(): string {
    const open = this.loadOrders().filter((o) => o.status === "open");
    if (open.length === 0) return "no open orders";
    return open
      .map((o, i) => {
        const size = o.solLamports !== undefined ? fmtSol(o.solLamports) : "";
        const head = `${i + 1}. [${o.id}] ${o.kind} ${shortKey(o.mint, 6)}`;
        const at = `@ ${fmtPrice(o.triggerPriceSol)} SOL`;
        return size ? `${head} ${at} size ${size}` : `${head} ${at}`;
      })
      .join("\n");
  }

  orderCancel(id: string): string {
    const store = new OrderStore(this.orderFile());
    const orders = store.load();
    const hit = orders.find((o) => o.id === id && o.status === "open");
    if (!hit) throw new CmdError(`no open order with id "${id}"`);
    hit.status = "cancelled";
    store.save(orders);
    return `order ${id} cancelled`;
  }

  orderFillText(o: Order): string {
    return [
      `ORDER FILLED [${o.id}]`,
      `kind    ${o.kind}`,
      `mint    ${o.mint}`,
      `trigger ${fmtPrice(o.triggerPriceSol)} SOL`,
      o.note ? `note    ${o.note}` : "",
    ].join("\n");
  }

  /* --------------------------- helpers ----------------------------- */

  orderFile(): string {
    return path.isAbsolute(this.cfg.ordersFile)
      ? this.cfg.ordersFile
      : path.join(this.cfg.rootDir, this.cfg.ordersFile);
  }

  loadOrders(): Order[] {
    return new OrderStore(this.orderFile()).load();
  }

  get paper(): PaperWallet {
    return new PaperWallet(this.cfg.paperFile, this.cfg.paperStartingSol);
  }
}

/** All order kinds the CLI / Telegram accept for `order add`. */
const ORDER_KINDS: OrderKind[] = ["buy-limit", "sell-limit", "take-profit", "stop-loss"];

/** Command cheat-sheet shared by the Telegram bot (/help) and printed docs. */
export function helpText(): string {
  return [
    "sol-trader 2026 — command reference",
    "",
    "TRADES",
    "/buy <mint> [sol]       buy a token (safety filters apply)",
    "/sell <mint> [pct]      sell pct% of holdings (default 100)",
    "/price <mint>           live price in SOL per token",
    "/balance [address]      SOL balance",
    "/wallet                 trading wallet public key",
    "/status                 wallet + engine states",
    "",
    "ENGINES",
    "/snipe on [sol]         start Pump.fun sniper",
    "/snipe off | /snipe status",
    "/copy on | /copy off | /copy status",
    "/orders on | /orders off | /orders list | /orders status",
    "",
    "ORDERS (limit / TP / SL)",
    "/order add <kind> <mint> <triggerSol> [size]",
    "  kind = buy-limit | sell-limit | take-profit | stop-loss",
    "  buy-limit size = SOL to spend | sell size = pct% of holdings",
    "/order list | /order cancel <id>",
    "",
    "BUYERS BEWARE: crypto is volatile; safety filters never guarantee profit.",
  ].join("\n");
}

