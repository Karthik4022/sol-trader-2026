import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import type { Config } from "./config.js";
import { logger } from "./logger.js";
import { priceSolPerToken, sellToken } from "./jupiter.js";
import { buySmart, pumpCurveState } from "./actions.js";
import { fromRaw, tokenBalanceRaw, fetchMint } from "./tokens.js";
import { executePumpSell } from "./pump-buy.js";
import { recentPriorityFee } from "./rpc.js";

export type OrderKind = "buy-limit" | "sell-limit" | "take-profit" | "stop-loss";

export interface Order {
  id: string;
  kind: OrderKind;
  mint: string;
  triggerPriceSol: number; // price per token in SOL
  solLamports?: bigint; // buy orders: max SOL to spend
  tokenAmountRaw?: bigint; // sell orders: raw token amount (empty = all)
  createdAt: number;
  status: "open" | "done" | "cancelled" | "failed";
  lastPrice?: number;
  note?: string;
}

export class OrderStore {
  constructor(private file: string) {}

  /**
   * JSON cannot serialize BigInt. Orders carry solLamports / tokenAmountRaw as
   * bigint, so stringify them as decimal strings (JSON.stringify drops
   * undefined fields, so optional bigints simply stay absent).
   */
  private static replacer(_key: string, value: unknown): unknown {
    return typeof value === "bigint" ? value.toString() : value;
  }

  /**
   * Restores solLamports / tokenAmountRaw to bigint on load. Accepts decimal
   * strings (written by us) and integer numbers (hand-edited files). Any
   * malformed value is dropped instead of crashing the whole store.
   */
  private static reviver(key: string, value: unknown): unknown {
    if ((key === "solLamports" || key === "tokenAmountRaw") && value !== null && value !== undefined) {
      try {
        return BigInt(value as string | number);
      } catch {
        return undefined;
      }
    }
    return value;
  }

  load(): Order[] {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"), OrderStore.reviver) as Order[];
    } catch {
      return [];
    }
  }

  save(orders: Order[]): void {
    const file = path.resolve(this.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(orders, OrderStore.replacer, 2));
  }
}

function crossed(kind: OrderKind, price: number, trigger: number): boolean {
  switch (kind) {
    case "buy-limit":
      return price <= trigger; // wait for a dip
    case "sell-limit":
    case "take-profit":
      return price >= trigger;
    case "stop-loss":
      return price <= trigger;
  }
}

/**
 * Off-chain limit / TP / SL engine. Prices come from the bonding-curve
 * reserves while the token is still pre-migration and from a live Jupiter
 * quote afterwards. Orders fill through the cheapest matching route:
 *   - buy-limit  -> buySmart  (curve first, Jupiter fallback)
 *   - sell side  -> Pump.fun curve while present, else Jupiter swap
 * The engine is stop-safe: requestStop() exits the polling loop cleanly.
 */
export class LimitOrderEngine {
  /** Optional hook fired whenever an order fills (used for TG alerts). */
  onFill?: (o: Order) => void;

  private stopReq = false;

  constructor(
    private cfg: Config,
    private conn: Connection,
    private wallet: Keypair,
    private store: OrderStore
  ) {}

  /** Asks the polling loop to exit after the current tick. */
  requestStop(): void {
    this.stopReq = true;
  }

  async run(): Promise<void> {
    logger.info("orders", `engine polling every ${this.cfg.orderPollMs} ms`);
    while (!this.stopReq) {
      try {
        await this.tick();
      } catch (e) {
        logger.error("orders", `tick failed: ${(e as Error).message}`);
      }
      await sleep(this.cfg.orderPollMs);
    }
    logger.info("orders", "engine stopped");
  }

  private async tick(): Promise<void> {
    const orders = this.store.load().filter((o) => o.status === "open");
    if (!orders.length) return;
    for (const order of orders) {
      try {
        const mint = new PublicKey(order.mint);
        // Bonding-curve tokens have no Jupiter route yet: read the curve
        // price directly. Everything else polls a live Jupiter quote.
        let priceSol: number;
        const curve = await pumpCurveState(this.conn, mint);
        if (curve) priceSol = Number(curve.vSol) / Number(curve.vToken);
        else ({ priceSol } = await priceSolPerToken(this.conn, this.cfg, mint));
        order.lastPrice = priceSol;
        logger.info(
          "orders",
          `${order.kind} ${order.mint.slice(0, 8)}… price=${priceSol.toFixed(10)} trigger=${order.triggerPriceSol}`
        );
        if (crossed(order.kind, priceSol, order.triggerPriceSol)) {
          await this.execute(order);
          order.status = "done";
          order.note = `filled at ${priceSol}`;
          this.onFill?.(order);
        }
      } catch (e) {
        logger.warn("orders", `check ${order.id} failed: ${(e as Error).message}`);
      }
      this.persist(orders);
    }
  }

  private async execute(order: Order): Promise<void> {
    const mint = new PublicKey(order.mint);
    logger.info("orders", `EXECUTING ${order.kind} on ${order.mint.slice(0, 10)}…`);
    if (order.kind === "buy-limit") {
      const lamports = order.solLamports ?? BigInt(Math.round(0.1 * LAMPORTS_PER_SOL));
      // buySmart buys on the bonding curve while pre-migration and routes
      // through Jupiter once the token has migrated.
      await buySmart(this.conn, this.cfg, this.wallet, mint, lamports, this.cfg.slippagePct);
      return;
    }
    // Sell-side: take-profit / stop-loss / sell-limit.
    let amount = order.tokenAmountRaw;
    if (!amount) {
      amount = await tokenBalanceRaw(this.conn, this.wallet.publicKey, mint);
    }
    if (amount <= 0n) {
      logger.warn("orders", `no balance for ${mint.toBase58().slice(0, 8)}…, nothing to sell`);
      return;
    }
    const cuPrice = await recentPriorityFee(this.conn);
    try {
      const curve = await pumpCurveState(this.conn, mint);
      if (curve) {
        await executePumpSell(this.conn, this.wallet, mint, amount, this.cfg.slippagePct, {
          jitoTipSol: this.cfg.jitoTipSol,
          computeUnitPrice: cuPrice,
          computeUnitLimit: 150_000,
        });
      } else {
        await sellToken(this.conn, this.cfg, this.wallet, mint, amount, this.cfg.slippagePct);
      }
    } catch (e) {
      // Migration race between our check and the send: re-check the curve
      // once and fall back to the other route.
      const curveNow = await pumpCurveState(this.conn, mint);
      if (curveNow) {
        await executePumpSell(this.conn, this.wallet, mint, amount, this.cfg.slippagePct, {
          jitoTipSol: this.cfg.jitoTipSol,
          computeUnitPrice: cuPrice,
          computeUnitLimit: 150_000,
        });
      } else {
        await sellToken(this.conn, this.cfg, this.wallet, mint, amount, this.cfg.slippagePct);
      }
    }
  }

  private persist(orders: Order[]): void {
    const all = this.store.load();
    const ids = new Set(orders.map((o) => o.id));
    this.store.save([...orders, ...all.filter((o) => !ids.has(o.id))]);
  }
}

export function makeOrder(
  kind: OrderKind,
  mint: PublicKey,
  triggerPriceSol: number,
  solLamports?: bigint,
  tokenAmountRaw?: bigint
): Order {
  return {
    id: randomUUID().slice(0, 8),
    kind,
    mint: mint.toBase58(),
    triggerPriceSol,
    solLamports,
    tokenAmountRaw,
    createdAt: Date.now(),
    status: "open",
  };
}

export async function tokenBalanceUi(
  conn: Connection,
  wallet: PublicKey,
  mint: PublicKey
): Promise<{ raw: bigint; ui: number; decimals: number }> {
  const { decimals } = await fetchMint(conn, mint);
  const raw = await tokenBalanceRaw(conn, wallet, mint);
  return { raw, ui: fromRaw(raw, decimals), decimals };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}



