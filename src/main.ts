#!/usr/bin/env node
/**
 * sol-trader 2026 — CLI entry point.
 *
 * Usage:
 *   node dist/main.js wallet new|show|balance
 *   node dist/main.js buy <mint> [sol]
 *   node dist/main.js sell <mint> [pct]
 *   node dist/main.js price <mint>
 *   node dist/main.js snipe [solPerBuy]      (foreground, Ctrl+C to stop)
 *   node dist/main.js copy                   (foreground, Ctrl+C to stop)
 *   node dist/main.js order run|add|list|cancel|status
 *   node dist/main.js bot                    (Telegram control bot, Ctrl+C to stop)
 */
import { Command } from "commander";
import { loadConfig, ensureDataDirs } from "./config.js";
import { App } from "./controller.js";
import { createKeypairFile } from "./wallet.js";
import { TelegramBot } from "./telegram.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  ensureDataDirs(cfg);
  const app = new App(cfg);

  const program = new Command();
  program
    .name("sol-trader")
    .description(
      "2026 Solana trading engine: Pump.fun sniper, Jupiter swaps, " +
        "limit/TP-SL orders, wallet copy-trading, Telegram remote control"
    )
    .version("1.0.0")
    .showHelpAfterError()
    .showSuggestionAfterError();

  /* ----------------------------- wallet ---------------------------- */

  const wallet = program.command("wallet").description("trading wallet management");
  wallet
    .command("new")
    .argument("[label]", "label of the wallet file", "default")
    .description("generate a fresh keypair and save it under data/wallets/<label>.json")
    .action(async (label: string) => {
      const kp = createKeypairFile(cfg.rootDir, label);
      console.log(`Wallet public key : ${kp.publicKey.toBase58()}`);
      console.log(`Saved secret      : data/wallets/${label}.json  (never share)`);
    });
  wallet
    .command("show")
    .description("show the configured trading wallet public key")
    .action(async () => console.log(app.walletAddress()));
  wallet
    .command("balance")
    .argument("[address]", "any Solana address; defaults to the trading wallet")
    .description("SOL balance of an address")
    .action(async (address?: string) => console.log(await app.balance(address)));

  /* ------------------------------ trades --------------------------- */

  program
    .command("buy")
    .argument("<mint>", "token mint address")
    .argument("[solAmount]", "SOL to spend (default: SNIPE_BUDGET_SOL)")
    .description("buy a token via smart route (Pump.fun curve or Jupiter)")
    .action(async (mint: string, solAmount?: string) =>
      console.log(await app.buy(mint, solAmount))
    );
  program
    .command("sell")
    .argument("<mint>", "token mint address")
    .argument("[pct]", "percent of holdings to sell, 1..100 (default 100)")
    .description("sell a token via smart route (Pump.fun curve or Jupiter)")
    .action(async (mint: string, pct?: string) => console.log(await app.sell(mint, pct)));
  program
    .command("price")
    .argument("<mint>", "token mint address")
    .description("current price of one token in SOL")
    .action(async (mint: string) => console.log(await app.price(mint)));
  program
    .command("balance")
    .alias("bal")
    .argument("[address]", "any Solana address; defaults to the trading wallet")
    .description("SOL balance of an address")
    .action(async (address?: string) => console.log(await app.balance(address)));
  program
    .command("status")
    .description("wallet, balances and engine states")
    .action(async () => console.log(await app.status()));

  /* ---------------------------- sniper ----------------------------- */

  program
    .command("snipe")
    .argument("[solPerBuy]", "override the per-buy budget in SOL")
    .description("run the Pump.fun sniper until Ctrl+C")
    .action(async (solPerBuy?: string) => {
      const budget = solPerBuy === undefined ? undefined : Number(solPerBuy);
      await runForever(async () => app.startSniper(budget), async () => app.stopSniper());
    });

  /* -------------------------- copy trader -------------------------- */

  program
    .command("copy")
    .description("run the copy-trader until Ctrl+C (mirrors COPY_TRADE_WALLETS)")
    .action(async () => {
      await runForever(
        async () => app.startCopy(),
        async () => app.stopCopy()
      );
    });

  /* ---------------------------- orders ----------------------------- */

  const order = program
    .command("order")
    .alias("orders")
    .description("limit / take-profit / stop-loss engine and order CRUD");
  order
    .command("run")
    .description("poll and fill open orders until Ctrl+C")
    .action(async () => {
      await runForever(
        async () => app.startOrderEngine(),
        async () => app.stopOrderEngine()
      );
    });
  order
    .command("add")
    .argument("<kind>", "buy-limit | sell-limit | take-profit | stop-loss")
    .argument("<mint>", "token mint address")
    .argument("<trigger>", "trigger price per token in SOL")
    .argument("[size]", "buy-limit: SOL to spend | sell kinds: pct% (default 100%)")
    .description("create a new open order")
    .action(async (kind: string, mint: string, trigger: string, size?: string) =>
      console.log(await app.orderAdd(kind, mint, trigger, size))
    );
  order
    .command("list")
    .description("list open orders")
    .action(async () => console.log(app.orderList()));
  order
    .command("cancel")
    .argument("<id>", "order id")
    .description("cancel an open order")
    .action(async (id: string) => console.log(app.orderCancel(id)));
  order
    .command("status")
    .description("order engine + open order summary")
    .action(async () => console.log(app.ordersStatus()));

  /* ---------------------------- telegram --------------------------- */

  program
    .command("bot")
    .description("run the Telegram control bot until Ctrl+C")
    .action(async () => {
      if (!cfg.tgBotToken) {
        throw new Error(
          "TG_BOT_TOKEN is not set. Create a bot with @BotFather and add the token to .env"
        );
      }
      const bot = new TelegramBot(cfg, app);
      await runForever(
        () => {
          void bot.run().catch((e: Error) => {
            console.error(`error: ${e.message}`);
            process.exit(1);
          });
          return "Telegram bot polling… (Ctrl+C to stop)";
        },
        () => {
          bot.stop();
          return "Telegram bot stopped";
        }
      );
    });

  await program.parseAsync(process.argv);
}

/* Runs a foreground engine; stops it gracefully on Ctrl+C / SIGTERM. */
async function runForever(
  onStart: () => Promise<string> | string,
  onStop: () => Promise<string> | string
): Promise<void> {
  let done: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const onSig = (): void => done();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);
  try {
    console.log(await onStart());
    await finished;
    console.log(await onStop());
  } finally {
    process.removeListener("SIGINT", onSig);
    process.removeListener("SIGTERM", onSig);
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`error: ${msg}`);
  process.exit(1);
});

