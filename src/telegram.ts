import type { Config } from "./config.js";
import { logger } from "./logger.js";
import { App, helpText } from "./controller.js";
import { UserStore, generateWalletSecret, normalizeWalletSecret } from "./user-store.js";
import { PaperWallet } from "./paper-wallet.js";
import { toPublicKey } from "./wallet.js";

/* ------------------------------------------------------------------ */
/* Minimal Telegram Bot API client (no extra dependency: plain fetch). */
/* Long-polling via getUpdates; commands are authorized by TG_CHAT_ID.  */
/* ------------------------------------------------------------------ */

interface TgMessage {
  message_id: number;
  chat?: { id: number | string; type?: string };
  text?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}
interface TgReply {
  ok?: boolean;
  description?: string;
  result?: unknown;
  error_code?: number;
}
interface TgMe {
  ok?: boolean;
  description?: string;
  result?: { username?: string; first_name?: string };
}

type UiFlow =
  | { kind: "setup-private-key" }
  | { kind: "setup-budget"; privateKey: string }
  | { kind: "setup-slippage"; privateKey: string; budget: number }
  | { kind: "setup-copy-wallets"; privateKey: string; budget: number; slippage: number }
  | { kind: "setting-value"; field: "wallet" | "budget" | "slippage" | "copy-wallets" | "copy-mult" | "copy-min" | "sell-pct" | "paper-balance" }
  | { kind: "settings-menu" }
  | { kind: "wallet-menu" }
  | { kind: "copy-menu" }
  | { kind: "buy-mint" }
  | { kind: "buy-sol"; mint: string }
  | { kind: "sell-mint" }
  | { kind: "sell-pct"; mint: string }
  | { kind: "price-mint" }
  | { kind: "balance-address" }
  | { kind: "snipe-budget" }
  | { kind: "order-kind" }
  | { kind: "order-mint"; orderKind: string }
  | { kind: "order-trigger"; orderKind: string; mint: string }
  | { kind: "order-size"; orderKind: string; mint: string; trigger: string }
  | { kind: "confirm"; label: string; run: () => Promise<string> | string };

const API = "https://api.telegram.org";

export class TelegramBot {
  private offset = 0;
  private stopped = false;
  private readonly allowed: Set<string>;
  private readonly flows = new Map<string, UiFlow>();
  private readonly users: UserStore;
  private readonly userApps = new Map<string, App>();

  constructor(
    private cfg: Config,
    private app: App,
    private pollIntervalMs = 1000
  ) {
    this.allowed = new Set(
      cfg.tgChatId
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    this.users = new UserStore(cfg.rootDir, 10);
  }

  get configured(): boolean {
    return Boolean(this.cfg.tgBotToken);
  }

  async run(): Promise<void> {
    if (!this.cfg.tgBotToken) throw new Error("TG_BOT_TOKEN is not set");

    const me = (await this.api("getMe")) as TgMe;
    if (!me.ok) {
      throw new Error(`Telegram getMe failed: ${me.description ?? "bad token?"}`);
    }
    const handle = me.result?.username ? `@${me.result.username}` : "";
    logger.info("telegram", `bot ${handle} ready for public onboarding (maximum 10 user profiles)`);

    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (e) {
        logger.error("telegram", `poll failed: ${(e as Error).message}`);
        await sleep(3000);
      }
      if (!this.stopped) await sleep(this.pollIntervalMs);
    }
    this.app.onEvent = undefined;
    logger.info("telegram", "bot stopped");
  }

  stop(): void {
    this.stopped = true;
  }

  /* ------------------------- long polling -------------------------- */

  private async pollOnce(): Promise<void> {
    const url =
      `${API}/bot${this.cfg.tgBotToken}/getUpdates` +
      `?timeout=1&offset=${this.offset}&allowed_updates=${encodeURIComponent('["message"]')}`;
    const res = await fetch(url);
    const json = (await res.json()) as TgReply;
    if (!json.ok) {
      throw new Error(`getUpdates error ${json.error_code ?? ""}: ${json.description ?? "unknown"}`);
    }
    const updates = (json.result ?? []) as TgUpdate[];
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      await this.handleUpdate(u);
    }
  }

  private async handleUpdate(u: TgUpdate): Promise<void> {
    const msg = u.message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();
    if (chatId === undefined || !text) return; // only text messages matter

    const key = String(chatId);
    const currentFlow = this.flows.get(key);
    const isPrivateKeyStep = currentFlow?.kind === "setup-private-key" ||
      (currentFlow?.kind === "setting-value" && currentFlow.field === "wallet");
    logger.info("telegram", isPrivateKeyStep ? `private-key setup input from ${key} (redacted)` : `cmd from ${key}: ${text.slice(0, 120)}`);
    try {
      // A private key sent to a Telegram bot is not end-to-end encrypted. Remove
      // the chat copy immediately after receipt (the encrypted vault remains).
      if (isPrivateKeyStep) {
        await this.deleteMessage(key, msg!.message_id).catch((e: Error) =>
          logger.warn("telegram", `could not delete private-key message: ${e.message}`)
        );
      }
      const uiReply = await this.handleUi(key, text);
      if (uiReply !== undefined) {
        await this.send(key, uiReply, this.keyboardFor(key));
        return;
      }
      const reply = await this.dispatch(key, text);
      if (reply) await this.send(key, reply, mainKeyboard());
    } catch (e) {
      const errText = `error: ${(e as Error).message}`;
      logger.warn("telegram", errText);
      await this.send(key, errText, this.keyboardFor(key)).catch(() => undefined);
    }
  }

  /** Button-driven wizard. Commands remain available for power users. */
  private async handleUi(chatId: string, text: string): Promise<string | undefined> {
    const value = text.trim();
    if (value.startsWith("/start")) {
      this.flows.delete(chatId);
      return this.users.get(chatId)
        ? `Welcome back!\n\n${this.walletText(chatId)}`
        : `Welcome!\n\nStart instantly with a Paper Wallet (10 virtual SOL), or add a Real Wallet.\nProfiles: ${this.users.count()}/10`;
    }
    if (value === "⬅️ Back") {
      const current = this.flows.get(chatId);
      if (current?.kind === "setting-value") {
        this.flows.set(chatId, { kind: "settings-menu" });
        return this.settingsText(chatId);
      }
      this.flows.delete(chatId);
      return this.users.get(chatId) ? "Main menu" : "Choose Paper Wallet or Real Wallet to begin.";
    }
    if (value === "/cancel" || value === "❌ Cancel") {
      this.flows.delete(chatId);
      return "Cancelled. No action was taken.";
    }

    const flow = this.flows.get(chatId);
    if (flow) return this.advanceFlow(chatId, flow, value);

    if (value === "⚙️ Setup") {
      this.flows.set(chatId, { kind: "setup-private-key" });
      return "Send your Solana base58 private key or 12/24-word seed phrase. It will be encrypted locally and this Telegram message will be deleted immediately:";
    }
    if (value === "🧪 Start with Paper Wallet") {
      this.users.save({
        chatId,
        walletPrivateKey: generateWalletSecret(),
        realWalletConfigured: false,
        snipeBudgetSol: this.cfg.snipeBudgetLamports / 1e9,
        slippagePct: this.cfg.slippagePct,
        copyTradeWallets: [],
        copyTradeSizeMult: this.cfg.copyTradeSizeMult,
        copyTradeMinSol: this.cfg.copyTradeMinSol,
        copyTradeAutoSell: true,
        copyTradeSellPct: 100,
        paperMode: true,
        paperStartingSol: 10,
        createdAt: new Date().toISOString(),
      });
      return "✅ Paper Wallet ready with 10 virtual SOL.\nNo private key is needed. You can add a Real Wallet later from Settings.";
    }
    if (value === "💳 Add Real Wallet") {
      this.flows.set(chatId, { kind: "setup-private-key" });
      return "Send your Solana private key or 12/24-word seed phrase. The message will be deleted immediately:";
    }
    if (!this.users.get(chatId)) {
      if (value.startsWith("/start") || value === "❓ Help") {
        return `Welcome! Start with a Paper Wallet instantly, or add a Real Wallet.\nProfiles: ${this.users.count()}/10`;
      }
      return "Choose Paper Wallet to start instantly, or add a Real Wallet.";
    }

    const app = this.appFor(chatId);

    switch (value) {
      case "👛 Wallet": {
        this.flows.set(chatId, { kind: "wallet-menu" });
        return this.walletText(chatId);
      }
      case "🧪 Use Paper Wallet":
        this.users.update(chatId, { paperMode: true });
        this.resetApp(chatId);
        return `✅ Paper Wallet selected\n\n${this.walletText(chatId)}`;
      case "💳 Use Real Wallet":
        if (!this.users.get(chatId)!.realWalletConfigured) {
          this.flows.set(chatId, { kind: "setting-value", field: "wallet" });
          return "Real Wallet is not added yet. Send your private key or 12/24-word phrase. This message will be deleted immediately:";
        }
        this.users.update(chatId, { paperMode: false });
        this.resetApp(chatId);
        return `✅ Real Wallet selected\n\n${this.walletText(chatId)}`;
      case "🛠 Settings":
        this.flows.set(chatId, { kind: "settings-menu" });
        return this.settingsText(chatId);
      case "🔐 Wallet / phrase":
        this.flows.set(chatId, { kind: "setting-value", field: "wallet" });
        return "Send the new private key or 12/24-word phrase. This message will be deleted immediately:";
      case "💵 Buy amount":
        this.flows.set(chatId, { kind: "setting-value", field: "budget" });
        return "Enter default buy amount in SOL:";
      case "〰️ Slippage":
        this.flows.set(chatId, { kind: "setting-value", field: "slippage" });
        return "Enter slippage percentage (0.1–100):";
      case "👛 Copy wallets":
        this.flows.set(chatId, { kind: "setting-value", field: "copy-wallets" });
        return "Send target wallets separated by commas, or send NONE to clear:";
      case "✖️ Copy multiplier":
        this.flows.set(chatId, { kind: "setting-value", field: "copy-mult" });
        return "Enter multiplier (0.25 = quarter size, 1 = same size):";
      case "🔻 Minimum copy":
        this.flows.set(chatId, { kind: "setting-value", field: "copy-min" });
        return "Enter minimum copy-buy amount in SOL:";
      case "🔄 Auto-sell toggle": {
        const p = this.users.get(chatId)!;
        this.users.update(chatId, { copyTradeAutoSell: !p.copyTradeAutoSell });
        this.resetApp(chatId);
        return `Auto-sell is now ${!p.copyTradeAutoSell ? "ON" : "OFF"}.`;
      }
      case "📉 Auto-sell %":
        this.flows.set(chatId, { kind: "setting-value", field: "sell-pct" });
        return "Enter percentage of your holdings to sell when target sells (1–100):";
      case "🧪 Paper mode toggle": {
        const p = this.users.get(chatId)!;
        this.users.update(chatId, { paperMode: !p.paperMode });
        this.resetApp(chatId);
        return `Trading mode is now ${!p.paperMode ? "PAPER — no real transactions" : "REAL"}.`;
      }
      case "🏦 Paper balance":
        this.flows.set(chatId, { kind: "setting-value", field: "paper-balance" });
        return "Enter the virtual SOL balance. This resets paper positions and trade history:";
      case "📒 Paper portfolio": {
        const cfg = this.users.configFor(this.cfg, chatId);
        return new PaperWallet(cfg.paperFile, cfg.paperStartingSol).summary();
      }
      case "🟢 Buy":
        this.flows.set(chatId, { kind: "buy-mint" });
        return "Send the token mint address:";
      case "🔴 Sell":
        this.flows.set(chatId, { kind: "sell-mint" });
        return "Send the token mint address:";
      case "💹 Price":
        this.flows.set(chatId, { kind: "price-mint" });
        return "Send the token mint address:";
      case "💰 Balance":
        this.flows.set(chatId, { kind: "balance-address" });
        return "Send a wallet address, or tap My wallet:";
      case "🎯 Sniper":
        this.flows.set(chatId, { kind: "snipe-budget" });
        return `Sniper is ${app.sniperStatus()}\nSend SOL per buy, or tap Stop:`;
      case "👥 Copy trade":
        if (this.users.get(chatId)!.copyTradeWallets.length === 0) {
          this.flows.set(chatId, { kind: "setting-value", field: "copy-wallets" });
          return "Copy wallet is not configured yet.\n\nSend the trader's Solana public wallet address. For multiple wallets, separate them with commas:";
        }
        this.flows.set(chatId, { kind: "copy-menu" });
        return `COPY TRADING\nStatus: ${app.copyStatus()}\n\nChoose Start or Stop.`;
      case "▶️ Start copy":
        this.flows.set(chatId, {
          kind: "confirm",
          label: "Start copy trading with the configured wallets?",
          run: () => app.startCopy(),
        });
        return "Start copy trading with the configured wallets?";
      case "⏹ Stop copy":
        return app.stopCopy();
      case "📋 Orders":
        this.flows.set(chatId, { kind: "order-kind" });
        return `Open orders:\n${app.orderList()}\n\nChoose an order type:`;
      case "📊 Status":
        return app.status();
      case "❓ Help":
        return helpText();
      default:
        return undefined;
    }
  }

  private async advanceFlow(chatId: string, flow: UiFlow, value: string): Promise<string> {
    const again = (message: string): string => message + "\nTap Cancel to exit.";
    const app = (): App => this.appFor(chatId);
    switch (flow.kind) {
      case "wallet-menu":
        this.flows.delete(chatId);
        return (await this.handleUi(chatId, value)) ?? "Choose Paper Wallet or Real Wallet.";
      case "copy-menu":
        this.flows.delete(chatId);
        if (value !== "▶️ Start copy" && value !== "⏹ Stop copy") {
          const wallets = this.parseCopyWallets(value);
          this.users.update(chatId, { copyTradeWallets: wallets });
          this.resetApp(chatId);
          this.flows.set(chatId, { kind: "copy-menu" });
          return `✅ ${wallets.length} copy wallet(s) saved.\n\nChoose Start or Stop.`;
        }
        return (await this.handleUi(chatId, value)) ?? "Choose Start or Stop.";
      case "settings-menu":
        this.flows.delete(chatId);
        return (await this.handleUi(chatId, value)) ?? "Choose a settings button.";
      case "setup-private-key": {
        const privateKey = normalizeWalletSecret(value);
        // Persist the wallet immediately. If the user cancels optional settings,
        // balance and wallet commands must still work with safe defaults.
        this.users.save({
          chatId,
          walletPrivateKey: privateKey,
          snipeBudgetSol: this.cfg.snipeBudgetLamports / 1e9,
          slippagePct: this.cfg.slippagePct,
          copyTradeWallets: [],
          copyTradeSizeMult: this.cfg.copyTradeSizeMult,
          copyTradeMinSol: this.cfg.copyTradeMinSol,
          copyTradeAutoSell: true,
          copyTradeSellPct: 100,
          paperMode: false,
          paperStartingSol: 10,
          realWalletConfigured: true,
          createdAt: new Date().toISOString(),
        });
        this.userApps.delete(chatId);
        this.flows.set(chatId, { kind: "setup-budget", privateKey });
        return again(
          `Wallet saved securely. Balance is now available.\nEnter default SOL per buy (current default ${this.cfg.snipeBudgetLamports / 1e9}):`
        );
      }
      case "setup-budget": {
        const budget = Number(value);
        if (!Number.isFinite(budget) || budget <= 0) return again("Enter a valid SOL amount greater than 0:");
        this.flows.set(chatId, { kind: "setup-slippage", privateKey: flow.privateKey, budget });
        return again("Enter swap slippage percentage (for example 15):");
      }
      case "setup-slippage": {
        const slippage = Number(value.replace("%", ""));
        if (!Number.isFinite(slippage) || slippage <= 0 || slippage > 100) return again("Enter slippage from 0.1 to 100:");
        this.flows.set(chatId, { kind: "setup-copy-wallets", privateKey: flow.privateKey, budget: flow.budget, slippage });
        return again("Send copy-trading wallet addresses separated by commas, or tap Skip:");
      }
      case "setup-copy-wallets": {
        const copyTradeWallets = value === "⏭ Skip" ? [] : value.split(",").map((s) => s.trim()).filter(Boolean);
        this.users.save({
          chatId,
          walletPrivateKey: flow.privateKey,
          snipeBudgetSol: flow.budget,
          slippagePct: flow.slippage,
          copyTradeWallets,
          copyTradeSizeMult: this.cfg.copyTradeSizeMult,
          copyTradeMinSol: this.cfg.copyTradeMinSol,
          copyTradeAutoSell: true,
          copyTradeSellPct: 100,
          paperMode: false,
          paperStartingSol: 10,
          realWalletConfigured: true,
          createdAt: new Date().toISOString(),
        });
        this.userApps.delete(chatId);
        this.flows.delete(chatId);
        return `Setup complete.\nWallet: ${this.appFor(chatId).walletAddress()}\nBudget: ${flow.budget} SOL\nSlippage: ${flow.slippage}%\nCopy wallets: ${copyTradeWallets.length}`;
      }
      case "setting-value": {
        const n = Number(value.replace("%", ""));
        let patch: Partial<import("./user-store.js").UserProfile>;
        switch (flow.field) {
          case "wallet": patch = { walletPrivateKey: normalizeWalletSecret(value), realWalletConfigured: true }; break;
          case "budget":
            if (!Number.isFinite(n) || n < 0.001) return again("Buy amount must be at least 0.001 SOL:");
            patch = { snipeBudgetSol: n }; break;
          case "slippage":
            if (!Number.isFinite(n) || n <= 0 || n > 100) return again("Slippage must be from 0.1 to 100:");
            patch = { slippagePct: n }; break;
          case "copy-wallets": patch = { copyTradeWallets: value.toUpperCase() === "NONE" ? [] : this.parseCopyWallets(value) }; break;
          case "copy-mult":
            if (!Number.isFinite(n) || n <= 0 || n > 10) return again("Multiplier must be greater than 0 and at most 10:");
            patch = { copyTradeSizeMult: n }; break;
          case "copy-min":
            if (!Number.isFinite(n) || n < 0.001) return again("Minimum must be at least 0.001 SOL:");
            patch = { copyTradeMinSol: n }; break;
          case "sell-pct":
            if (!Number.isFinite(n) || n <= 0 || n > 100) return again("Percentage must be from 1 to 100:");
            patch = { copyTradeSellPct: n }; break;
          case "paper-balance":
            if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return again("Paper balance must be greater than 0 and at most 1,000,000 SOL:");
            patch = { paperStartingSol: n };
            break;
        }
        this.users.update(chatId, patch);
        if (flow.field === "paper-balance") {
          const cfg = this.users.configFor(this.cfg, chatId);
          new PaperWallet(cfg.paperFile, n).reset(n);
        }
        this.flows.delete(chatId);
        this.resetApp(chatId);
        if (flow.field === "copy-wallets" && (patch.copyTradeWallets?.length ?? 0) > 0) {
          this.flows.set(chatId, { kind: "copy-menu" });
          return `✅ ${patch.copyTradeWallets!.length} copy wallet(s) saved.\n\nChoose Start to begin paper/real copy trading.`;
        }
        return `Setting saved.\n\n${this.settingsText(chatId)}`;
      }
      case "buy-mint":
        this.flows.set(chatId, { kind: "buy-sol", mint: value });
        return again("How much SOL do you want to spend?");
      case "buy-sol": {
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount <= 0) return again("Enter a valid SOL amount greater than 0:");
        this.flows.set(chatId, {
          kind: "confirm",
          label: `Buy ${flow.mint} using ${amount} SOL?`,
          run: () => app().buy(flow.mint, String(amount)),
        });
        return `Confirm BUY\nMint: ${flow.mint}\nSpend: ${amount} SOL`;
      }
      case "sell-mint":
        this.flows.set(chatId, { kind: "sell-pct", mint: value });
        return again("What percentage do you want to sell? (1–100)");
      case "sell-pct": {
        const pct = Number(value.replace("%", ""));
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return again("Enter a percentage from 1 to 100:");
        this.flows.set(chatId, {
          kind: "confirm",
          label: `Sell ${pct}% of ${flow.mint}?`,
          run: () => app().sell(flow.mint, String(pct)),
        });
        return `Confirm SELL\nMint: ${flow.mint}\nAmount: ${pct}%`;
      }
      case "price-mint":
        this.flows.delete(chatId);
        return app().price(value);
      case "balance-address":
        this.flows.delete(chatId);
        return app().balance(value === "👛 My wallet" ? undefined : value);
      case "snipe-budget":
        if (value === "⏹ Stop sniper") {
          this.flows.delete(chatId);
          return app().stopSniper();
        }
        if (!Number.isFinite(Number(value)) || Number(value) <= 0) return again("Enter a valid SOL budget greater than 0:");
        this.flows.set(chatId, {
          kind: "confirm",
          label: `Start sniper at ${value} SOL per buy?`,
          run: () => app().startSniper(Number(value)),
        });
        return `Start sniper with ${value} SOL per buy?`;
      case "order-kind":
        if (value === "▶️ Start engine") {
          this.flows.set(chatId, { kind: "confirm", label: "Start the live order engine?", run: () => app().startOrderEngine() });
          return "Start the live order engine?";
        }
        if (value === "⏹ Stop engine") {
          this.flows.delete(chatId);
          return app().stopOrderEngine();
        }
        if (!ORDER_KIND_BUTTONS.includes(value)) return again("Choose one of the order types below:");
        this.flows.set(chatId, { kind: "order-mint", orderKind: value });
        return again("Send the token mint address:");
      case "order-mint":
        this.flows.set(chatId, { kind: "order-trigger", orderKind: flow.orderKind, mint: value });
        return again("Enter the trigger price in SOL per token:");
      case "order-trigger":
        if (!Number.isFinite(Number(value)) || Number(value) <= 0) return again("Enter a valid trigger price greater than 0:");
        this.flows.set(chatId, { kind: "order-size", orderKind: flow.orderKind, mint: flow.mint, trigger: value });
        return again(flow.orderKind === "buy-limit" ? "Enter SOL to spend:" : "Enter percentage of holdings to sell (1–100):");
      case "order-size":
        if (!Number.isFinite(Number(value.replace("%", ""))) || Number(value.replace("%", "")) <= 0) return again("Enter a valid size greater than 0:");
        this.flows.set(chatId, {
          kind: "confirm",
          label: `Create ${flow.orderKind} order?`,
          run: () => app().orderAdd(flow.orderKind, flow.mint, flow.trigger, value),
        });
        return `Confirm order\nType: ${flow.orderKind}\nMint: ${flow.mint}\nTrigger: ${flow.trigger} SOL\nSize: ${value}`;
      case "confirm":
        if (value !== "✅ Confirm") return "Please tap Confirm or Cancel.";
        this.flows.delete(chatId);
        return await flow.run();
    }
  }

  private keyboardFor(chatId: string): object {
    const flow = this.flows.get(chatId);
    if (!flow) return this.users.get(chatId) ? mainKeyboard() : setupKeyboard();
    if (flow.kind === "settings-menu") return settingsKeyboard();
    if (flow.kind === "wallet-menu") return walletKeyboard();
    if (flow.kind === "copy-menu") return copyKeyboard();
    if (flow.kind === "setup-copy-wallets") return replyKeyboard([["⏭ Skip"], ["⬅️ Back"]]);
    if (flow.kind === "confirm") return replyKeyboard([["✅ Confirm"], ["⬅️ Back"]]);
    if (flow.kind === "balance-address") return replyKeyboard([["👛 My wallet"], ["⬅️ Back"]]);
    if (flow.kind === "snipe-budget") return replyKeyboard([["⏹ Stop sniper"], ["⬅️ Back"]]);
    if (flow.kind === "order-kind") return replyKeyboard([
      ["buy-limit", "sell-limit"],
      ["take-profit", "stop-loss"],
      ["▶️ Start engine", "⏹ Stop engine"],
      ["⬅️ Back"],
    ]);
    return replyKeyboard([["⬅️ Back"]]);
  }

  private async dispatch(chatId: string, text: string): Promise<string> {
    if (!this.users.get(chatId)) return "Your profile is not configured. Tap ⚙️ Setup first.";
    const app = this.appFor(chatId);
    const argv = text.split(/\s+/).filter(Boolean);
    const cmd = (argv.shift() ?? "").toLowerCase().replace(/^\/+/, "");
    const [a, b, c, d] = argv as [string?, string?, string?, string?];

    switch (cmd) {
      case "help":
      case "start":
        return helpText();
      case "buy":
        if (!a) return "usage: /buy <mint> [sol]";
        return app.buy(a, b);
      case "sell":
        if (!a) return "usage: /sell <mint> [pct]";
        return app.sell(a, b);
      case "price":
        if (!a) return "usage: /price <mint>";
        return app.price(a);
      case "balance":
        return app.balance(a);
      case "wallet":
        return app.walletAddress();
      case "status":
        return app.status();
      case "snipe": {
        if (!a || a === "status") return `sniper: ${app.sniperStatus()}`;
        if (a === "on") {
          const budget = b !== undefined ? Number(b) : undefined;
          if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
            throw new Error(`invalid budget "${b}"`);
          }
          return app.startSniper(budget);
        }
        if (a === "off") return app.stopSniper();
        return "usage: /snipe on [sol] | /snipe off | /snipe status";
      }
      case "copy": {
        if (!a || a === "status") return `copy: ${app.copyStatus()}`;
        if (a === "on") return app.startCopy();
        if (a === "off") return app.stopCopy();
        return "usage: /copy on | /copy off | /copy status";
      }
      case "orders": {
        if (!a || a === "status") return `orders: ${app.ordersStatus()}`;
        if (a === "on") return app.startOrderEngine();
        if (a === "off") return app.stopOrderEngine();
        if (a === "list") return app.orderList();
        return "usage: /orders on | /orders off | /orders list | /orders status";
      }
      case "order": {
        if (a === "add") {
          if (!b || !c || !d) {
            return "usage: /order add <buy-limit|sell-limit|take-profit|stop-loss> <mint> <triggerSol> [sol|pct%]";
          }
          return app.orderAdd(b, c, d, e4(argv));
        }
        if (a === "list") return app.orderList();
        if (a === "cancel") {
          if (!b) return "usage: /order cancel <id>";
          return app.orderCancel(b);
        }
        return "usage: /order add … | /order list | /order cancel <id>";
      }
      default:
        return `unknown command "/${cmd}"\n\n${helpText()}`;
    }
  }

  private appFor(chatId: string): App {
    const existing = this.userApps.get(chatId);
    if (existing) return existing;
    const app = new App(this.users.configFor(this.cfg, chatId));
    app.onEvent = (text: string) => {
      this.send(chatId, text, mainKeyboard()).catch((e: Error) =>
        logger.warn("telegram", `alert push failed for ${chatId}: ${e.message}`)
      );
    };
    this.userApps.set(chatId, app);
    return app;
  }

  private resetApp(chatId: string): void {
    const app = this.userApps.get(chatId);
    if (app) {
      app.stopSniper();
      app.stopCopy();
      app.stopOrderEngine();
    }
    this.userApps.delete(chatId);
  }

  private settingsText(chatId: string): string {
    const p = this.users.get(chatId)!;
    return [
      "USER SETTINGS",
      `Default buy: ${p.snipeBudgetSol} SOL`,
      `Slippage: ${p.slippagePct}%`,
      `Copy wallets: ${p.copyTradeWallets.length}`,
      `Copy multiplier: ${p.copyTradeSizeMult ?? this.cfg.copyTradeSizeMult}×`,
      `Minimum copy: ${p.copyTradeMinSol ?? this.cfg.copyTradeMinSol} SOL`,
      `Auto-sell: ${p.copyTradeAutoSell ? "ON" : "OFF"}`,
      `Auto-sell amount: ${p.copyTradeSellPct ?? 100}%`,
      `Mode: ${p.paperMode ? "PAPER" : "REAL"}`,
      `Paper starting balance: ${p.paperStartingSol ?? 10} SOL`,
      "\nChoose a setting below:",
    ].join("\n");
  }

  private walletText(chatId: string): string {
    const p = this.users.get(chatId)!;
    const cfg = this.users.configFor(this.cfg, chatId);
    const paper = new PaperWallet(cfg.paperFile, cfg.paperStartingSol);
    const address = p.realWalletConfigured ? this.appFor(chatId).walletAddress() : "";
    const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Not added";
    return [
      "SELECT WALLET",
      `Current: ${p.paperMode ? "🧪 Paper Wallet" : "💳 Real Wallet"}`,
      `🧪 Paper: ${paper.balance().toFixed(4)} virtual SOL`,
      `💳 Real: ${short}`,
      "",
      "Buy, Sell, Balance and Copy Trade will use the selected wallet.",
    ].join("\n");
  }

  private parseCopyWallets(value: string): string[] {
    const wallets = value.split(",").map((s) => s.trim()).filter(Boolean);
    if (wallets.length === 0) throw new Error("send at least one public wallet address");
    if (wallets.length > 20) throw new Error("maximum 20 copy wallets per user");
    for (const wallet of wallets) toPublicKey(wallet);
    return [...new Set(wallets)];
  }

  /* --------------------------- helpers ----------------------------- */

  private async api(method: string): Promise<TgReply> {
    const url = `${API}/bot${this.cfg.tgBotToken}/${method}`;
    const res = await fetch(url);
    const json = (await res.json()) as TgReply;
    if (!res.ok) {
      throw new Error(
        `Telegram ${method} HTTP ${res.status}: ${json.description ?? res.statusText}`
      );
    }
    return json;
  }

  private async send(chatId: string, text: string, keyboard?: object): Promise<void> {
    const body = new URLSearchParams({
      chat_id: chatId,
      text: text.length > 4000 ? `${text.slice(0, 3997)}…` : text,
    });
    if (keyboard) body.set("reply_markup", JSON.stringify(keyboard));
    const url = `${API}/bot${this.cfg.tgBotToken}/sendMessage`;
    const res = await fetch(url, { method: "POST", body });
    const json = (await res.json()) as TgReply;
    if (!json.ok) {
      throw new Error(
        `sendMessage error ${json.error_code ?? ""}: ${json.description ?? "unknown"}`
      );
    }
  }

  private async deleteMessage(chatId: string, messageId: number): Promise<void> {
    const body = new URLSearchParams({ chat_id: chatId, message_id: String(messageId) });
    const res = await fetch(`${API}/bot${this.cfg.tgBotToken}/deleteMessage`, { method: "POST", body });
    const json = (await res.json()) as TgReply;
    if (!json.ok) throw new Error(json.description ?? "deleteMessage failed");
  }
}

const ORDER_KIND_BUTTONS = ["buy-limit", "sell-limit", "take-profit", "stop-loss"];

function replyKeyboard(keyboard: string[][]): object {
  return { keyboard, resize_keyboard: true, one_time_keyboard: false };
}

function mainKeyboard(): object {
  return replyKeyboard([
    ["👛 Wallet", "💰 Balance"],
    ["🟢 Buy", "🔴 Sell", "💹 Price"],
    ["👥 Copy trade", "📊 Status"],
    ["🛠 Settings", "❓ Help"],
  ]);
}

function setupKeyboard(): object {
  return replyKeyboard([
    ["🧪 Start with Paper Wallet"],
    ["💳 Add Real Wallet"],
    ["❓ Help"],
  ]);
}

function walletKeyboard(): object {
  return replyKeyboard([
    ["🧪 Use Paper Wallet"],
    ["💳 Use Real Wallet"],
    ["⬅️ Back"],
  ]);
}

function copyKeyboard(): object {
  return replyKeyboard([
    ["▶️ Start copy", "⏹ Stop copy"],
    ["⬅️ Back"],
  ]);
}

function settingsKeyboard(): object {
  return replyKeyboard([
    ["💵 Buy amount", "〰️ Slippage"],
    ["👛 Copy wallets", "✖️ Copy multiplier"],
    ["🔻 Minimum copy", "🔄 Auto-sell toggle"],
    ["📉 Auto-sell %", "🔐 Wallet / phrase"],
    ["🧪 Paper mode toggle", "🏦 Paper balance"],
    ["📒 Paper portfolio"],
    ["⬅️ Back"],
  ]);
}

/** Extra (5th+) positional argument for /order add (sell %/SOL size). */
function e4(argv: string[]): string | undefined {
  return argv.length > 4 ? argv[4] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
