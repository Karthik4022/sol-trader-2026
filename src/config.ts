import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

function envStr(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

export interface Config {
  rpcUrl: string;
  wsUrl: string;
  walletPrivateKey: string;
  snipeBudgetLamports: number;
  slippagePct: number;
  priorityLevel: string;
  maxPriorityFeeLamports: number;
  jitoTipSol: number;
  safety: {
    allowMintAuthority: boolean;
    allowFreezeAuthority: boolean;
    maxHolderPct: number;
    requireRenounced: boolean;
  };
  sniperFeed: 1 | 2;
  pumpportalUrl: string;
  sniperMaxDevFunding: number;
  sniperCooldownMs: number;
  copyTradeWallets: string[];
  copyTradeSizeMult: number;
  copyTradeMinSol: number;
  copyTradeAutoSell: boolean;
  copyTradeSellPct: number;
  paperMode: boolean;
  paperStartingSol: number;
  paperFile: string;
  ordersFile: string;
  orderPollMs: number;
  tgBotToken: string;
  tgChatId: string;
  jupApiBase: string;
  jupApiKey: string;
  rootDir: string;
}

export function loadConfig(): Config {
  const rootDir = path.resolve(envStr("ROOT_DIR", process.cwd()));
  const copyRaw = envStr("COPY_TRADE_WALLETS", "");
  return {
    rpcUrl: envStr("RPC_URL", "https://api.mainnet-beta.solana.com"),
    wsUrl: envStr("WS_URL", ""),
    walletPrivateKey: envStr("WALLET_PRIVATE_KEY", ""),
    snipeBudgetLamports: Math.round(envNum("SNIPE_BUDGET_SOL", 0.2) * 1e9),
    slippagePct: envNum("SLIPPAGE_PCT", 15),
    priorityLevel: envStr("PRIORITY_LEVEL", "high"),
    maxPriorityFeeLamports: envNum("MAX_PRIORITY_FEE_LAMPORTS", 2_500_000),
    jitoTipSol: envNum("JITO_TIP_SOL", 0),
    safety: {
      allowMintAuthority: envBool("SAFETY_MINT_AUTHORITY_OFF", true),
      allowFreezeAuthority: envBool("SAFETY_FREEZE_AUTHORITY_OFF", true),
      maxHolderPct: envNum("SAFETY_MAX_HOLDER_PCT", 30),
      requireRenounced: envBool("SAFETY_REQUIRE_RENOUNCED", false),
    },
    sniperFeed: envNum("SNIPER_FEED", 1) === 2 ? 2 : 1,
    pumpportalUrl: envStr("PUMPPORTAL_URL", "wss://pumpportal.fun/api/data"),
    sniperMaxDevFunding: envNum("SNIPER_MAX_DEV_FUNDING", 0),
    sniperCooldownMs: envNum("SNIPER_COOLDOWN_MS", 2000),
    copyTradeWallets: copyRaw.split(",").map((s) => s.trim()).filter(Boolean),
    copyTradeSizeMult: envNum("COPY_TRADE_SIZE_MULT", 0.25),
    copyTradeMinSol: envNum("COPY_TRADE_MIN_SOL", 0.01),
    copyTradeAutoSell: envBool("COPY_TRADE_AUTO_SELL", true),
    copyTradeSellPct: envNum("COPY_TRADE_SELL_PCT", 100),
    paperMode: envBool("PAPER_MODE", false),
    paperStartingSol: envNum("PAPER_STARTING_SOL", 10),
    paperFile: envStr("PAPER_FILE", path.join(rootDir, "data", "paper.json")),
    ordersFile: envStr("ORDERS_FILE", path.join(rootDir, "data", "orders.json")),
    orderPollMs: envNum("ORDER_POLL_MS", 4000),
    tgBotToken: envStr("TG_BOT_TOKEN", ""),
    tgChatId: envStr("TG_CHAT_ID", ""),
    jupApiBase: envStr("JUP_API_BASE", "https://lite-api.jup.ag/swap/v1"),
    jupApiKey: envStr("JUP_API_KEY", ""),
    rootDir,
  };
}

/** Ensure the data directory exists. */
export function ensureDataDirs(cfg: Config): void {
  for (const d of [
    path.join(cfg.rootDir, "data", "wallets"),
    path.dirname(cfg.ordersFile),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
