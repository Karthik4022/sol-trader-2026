import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import WebSocket from "ws";
import bs58 from "bs58";
import type { Config } from "./config.js";
import { PUMP_PROGRAM, PUMP_DISCRIMINATOR, pumpBondingCurve } from "./constants.js";
import { logger } from "./logger.js";
import { executePumpBuy } from "./pump-buy.js";
import { safetyCheck } from "./safety.js";
import { recentPriorityFee } from "./rpc.js";

export interface PumpToken {
  mint: PublicKey;
  bondingCurve: PublicKey;
  signature: string;
  name?: string;
  symbol?: string;
  dev?: PublicKey;
}

interface SnipeHandlers {
  onToken?: (t: PumpToken) => void;
  onError?: (err: Error) => void;
}

/** Cooldown set of already-processed mint addresses (also bounds memory). */
function makeSeen(): { has(m: string): boolean; add(m: string): void } {
  const s = new Set<string>();
  const MAX = 5000;
  return {
    has: (m) => s.has(m),
    add(m) {
      if (s.size > MAX) {
        const it = s.values().next().value;
        if (it !== undefined) s.delete(it);
      }
      s.add(m);
    },
  };
}

/**
 * Sniper engine. Watches for brand-new Pump.fun token mints and fires
 * a direct bonding-curve buy. Two interchangeable feeds:
 *   feed 1 = PumpPortal public WebSocket (subscribeNewToken)
 *   feed 2 = raw RPC logsSubscribe over the Pump.fun program
 */
export class Sniper {
  private cfg: Config;
  private conn: Connection;
  private wallet: Keypair;
  private seen = makeSeen();
  private ws: WebSocket | null = null;
  private subId: number | null = null;
  private logListener: ((logs: { err: unknown; logs: string[]; signature?: string }) => void) | null = null;
  private lastSnipeAt = 0;
  private stopped = false;

  /** Optional per-instance override in SOL (set by `/snipe on <budget>`). */
  public budgetOverrideSol?: number;

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Stops feeds and unsubscribes (safe to call more than once). */
  stop(): void {
    this.stopped = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (this.logListener) {
      try {
        if (this.subId !== null) this.conn.removeOnLogsListener(this.subId);
      } catch {
        /* ignore */
      }
      this.logListener = null;
    }
    this.subId = null;
    logger.info("sniper", "stopped");
  }

  constructor(cfg: Config, conn: Connection, wallet: Keypair) {
    this.cfg = cfg;
    this.conn = conn;
    this.wallet = wallet;
  }

  start(handlers: SnipeHandlers = {}): void {
    if (this.cfg.sniperFeed === 1) this.startPumpPortal(handlers);
    else this.startLogsFeed(handlers);
  }

  /** Buy budget for a single snipe in lamports (env or per-call override). */
  private budget(budgetSol?: number): bigint {
    const sol =
      budgetSol ?? this.budgetOverrideSol ?? this.cfg.snipeBudgetLamports / LAMPORTS_PER_SOL;
    return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
  }

  /** Common entry point: filters, safety, then a direct pump buy. */
  async onNewToken(token: PumpToken, handlers: SnipeHandlers, budgetSol?: number): Promise<void> {
    const m = token.mint.toBase58();
    if (this.seen.has(m)) return;
    this.seen.add(m);
    const now = Date.now();
    if (now - this.lastSnipeAt < this.cfg.sniperCooldownMs) {
      logger.debug("sniper", `cooldown, skipping ${m.slice(0, 10)}…`);
      return;
    }

    logger.info(
      "sniper",
      `NEW LAUNCH ${token.symbol ? `$${token.symbol} ` : ""}${m.slice(0, 12)}… ` +
        `sig ${token.signature.slice(0, 12)}…`
    );
    try {
      if (token.dev && this.cfg.sniperMaxDevFunding > 0) {
        const devBal = await this.conn.getBalance(token.dev, "confirmed");
        if (devBal > this.cfg.sniperMaxDevFunding * LAMPORTS_PER_SOL) {
          logger.info("sniper", `dev over-funded (${devBal / LAMPORTS_PER_SOL} SOL), skipping`);
          return;
        }
      }
      const safety = await safetyCheck(this.conn, this.cfg, token.mint);
      if (!safety.ok) {
        logger.warn("sniper", `safety blocked ${m.slice(0, 10)}…: ${safety.reasons.join("; ")}`);
        return;
      }

      const lamports = this.budget(budgetSol);
      const cuPrice = await recentPriorityFee(this.conn);
      const res = await executePumpBuy(
        this.conn,
        this.wallet,
        token.mint,
        token.bondingCurve,
        lamports,
        this.cfg.slippagePct,
        { jitoTipSol: this.cfg.jitoTipSol, computeUnitPrice: cuPrice, computeUnitLimit: 150_000 }
      );
      this.lastSnipeAt = Date.now();
      handlers.onToken?.({ ...token, bondingCurve: token.bondingCurve, signature: res.signature });
    } catch (e) {
      logger.warn("sniper", `buy for ${m.slice(0, 10)}… failed: ${(e as Error).message}`);
      handlers.onError?.(e as Error);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Feed 1: PumpPortal websocket                                        */
  /* ------------------------------------------------------------------ */
  private startPumpPortal(handlers: SnipeHandlers): void {
    const url = this.cfg.pumpportalUrl;
    logger.info("sniper", `PumpPortal feed starting: ${url}`);
    const connect = (): void => {
      if (this.stopped) return;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on("open", () => {
        logger.info("sniper", "PumpPortal connected, subscribing to new tokens");
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      });
      ws.on("message", (data) => {
        try {
          const evt = JSON.parse(data.toString()) as Record<string, any>;
          if (evt.type !== "tokenCreation") return;
          const mint = new PublicKey(evt.mint as string);
          const bc = new PublicKey((evt.bondingCurve as string) ?? pumpBondingCurve(mint));
          const dev = evt.dev ? new PublicKey(evt.dev as string) : undefined;
          void this.onNewToken(
            {
              mint,
              bondingCurve: bc,
              signature: String(evt.signature ?? ""),
              name: evt.name,
              symbol: evt.symbol,
              dev,
            },
            handlers
          );
        } catch (e) {
          logger.warn("sniper", `bad feed message: ${(e as Error).message}`);
        }
      });
      ws.on("close", () => {
        logger.warn("sniper", "PumpPortal disconnected, reconnecting in 3s");
        setTimeout(connect, 3000);
      });
      ws.on("error", (e) => logger.warn("sniper", `PumpPortal error: ${e.message}`));
    };
    connect();
  }

  /* ------------------------------------------------------------------ */
  /* Feed 2: raw RPC logsSubscribe on the Pump.fun program               */
  /* ------------------------------------------------------------------ */
  private startLogsFeed(handlers: SnipeHandlers): void {
    logger.info("sniper", `RPC log feed on ${PUMP_PROGRAM.toBase58()}`);
    const onLogs = async (
      logs: { err: unknown; logs: string[]; signature?: string }
    ): Promise<void> => {
      if (logs.err) return;
      const created = logs.logs.some(
        (l) => l.includes("Instruction: Create") && !l.includes("failed")
      );
      if (!created || !logs.signature) return;
      try {
        const token = await this.parseCreateTx(logs.signature);
        if (token) void this.onNewToken(token, handlers);
      } catch (e) {
        logger.debug("sniper", `parse create ${logs.signature.slice(0, 8)}…: ${(e as Error).message}`);
      }
    };
    this.logListener = onLogs;
    this.subId = this.conn.onLogs(PUMP_PROGRAM, onLogs, "confirmed") as unknown as number;
    logger.info("sniper", `logs subscription active (id ${this.subId})`);
  }

  /** Fetches a create transaction and extracts mint + bonding curve. */
  private async parseCreateTx(sig: string): Promise<PumpToken | null> {
    const parsed = await this.conn.getParsedTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
        if (!parsed || parsed.meta?.err) return null;

    const msg = parsed.transaction.message;
    // accountKeys may be plain strings (legacy) or { pubkey, ... } objects (v0).
    const rawKeys = (msg.accountKeys ?? []) as unknown as Array<
      string | { pubkey: string }
    >;
    const keyAt = (i: number): string => {
      const k = rawKeys[i];
      if (!k) throw new Error(`account index ${i} out of range`);
      return typeof k === "string" ? k : k.pubkey;
    };

    interface RawIx {
      programId?: string | { toBase58(): string };
      programIdIndex?: number;
      accounts?: Array<number | string>;
      data?: string;
    }
    // Flatten top-level + inner instructions.
    const ixs: RawIx[] = [
      ...((msg.instructions ?? []) as unknown as RawIx[]),
    ];
    for (const grp of (parsed.meta?.innerInstructions ?? []) as unknown as Array<{
      instructions?: RawIx[];
    }>) {
      ixs.push(...(grp.instructions ?? []));
    }

    const createDisc = Buffer.from(PUMP_DISCRIMINATOR.CREATE, "hex");
    const pumpAddr = PUMP_PROGRAM.toBase58();
    const isTokenOwner = (o: PublicKey): boolean => {
      const a = o.toBase58();
      return (
        a === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" || // SPL Token
        a === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" // Token-2022
      );
    };

    for (const ix of ixs) {
      let pid: string | undefined;
      if (typeof ix.programId === "string") pid = ix.programId;
      else if (ix.programId && typeof (ix.programId as { toBase58?: unknown }).toBase58 === "function") {
        pid = (ix.programId as { toBase58(): string }).toBase58();
      } else if (typeof ix.programIdIndex === "number") {
        pid = keyAt(ix.programIdIndex);
      }
      if (!pid || pid !== pumpAddr || !ix.data) continue;

      const data = Buffer.from(bs58.decode(ix.data));
      if (data.length < 8 || !data.subarray(0, 8).equals(createDisc)) continue;

      const resolved = (ix.accounts ?? []).map((a) =>
        typeof a === "number" ? keyAt(a) : a
      );
      if (resolved.length === 0) continue;

      // Prefer the canonical PDA; refine with on-chain owner checks so the
      // code is robust even if the account order of the Create ix changes.
      let mint = new PublicKey(resolved[0]);
      let bondingCurve = pumpBondingCurve(mint);
      try {
        const probe = resolved.slice(0, 8).map((a) => new PublicKey(a));
        const infos = await this.conn.getMultipleAccountsInfo(probe, "confirmed");
        const mintIdx = infos.findIndex(
          (inf) => inf !== null && inf.owner !== undefined && isTokenOwner(inf.owner)
        );
        const bcIdx = infos.findIndex(
          (inf) => inf !== null && inf.owner !== undefined && inf.owner.equals(PUMP_PROGRAM)
        );
        if (mintIdx >= 0) mint = new PublicKey(resolved[mintIdx]);
        if (bcIdx >= 0) bondingCurve = new PublicKey(resolved[bcIdx]);
        else bondingCurve = pumpBondingCurve(mint);
      } catch (e) {
        logger.debug("sniper", `owner probe failed, using PDA: ${(e as Error).message}`);
        bondingCurve = pumpBondingCurve(mint);
      }

      // Decode name / symbol / uri from the payload (8-byte discriminator + 3 strings).
      let name: string | undefined;
      let symbol: string | undefined;
      try {
        let off = 8;
        const readStr = (): string => {
          const len = data.readUInt32LE(off);
          off += 4;
          const out = data.subarray(off, off + len).toString("utf8");
          off += len;
          return out;
        };
        name = readStr();
        symbol = readStr();
        readStr(); // uri, unused for now
      } catch {
        /* metadata decode is best-effort */
      }

      return {
        mint,
        bondingCurve,
        signature: sig,
        name,
        symbol,
        dev: new PublicKey(keyAt(0)),
      };
    }
    return null;
  }
}
