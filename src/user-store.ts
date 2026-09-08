import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { mnemonicToSeedSync, validateMnemonic } from "bip39";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";
import type { Config } from "./config.js";
import { DatabaseSync } from "node:sqlite";

export interface UserProfile {
  chatId: string;
  walletPrivateKey: string;
  snipeBudgetSol: number;
  slippagePct: number;
  copyTradeWallets: string[];
  copyTradeSizeMult: number;
  copyTradeMinSol: number;
  copyTradeAutoSell: boolean;
  copyTradeSellPct: number;
  paperMode: boolean;
  paperStartingSol: number;
  realWalletConfigured: boolean;
  createdAt: string;
}

interface VaultFile {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** SQLite-backed profiles. Wallet secrets remain AES-256-GCM encrypted. */
export class UserStore {
  private readonly vaultPath: string;
  private readonly keyPath: string;
  private readonly db: DatabaseSync;

  constructor(private rootDir: string, private maxUsers = 10) {
    this.vaultPath = path.join(rootDir, "data", "users.vault");
    this.keyPath = path.join(rootDir, "data", ".users-vault-key");
    fs.mkdirSync(path.join(rootDir, "data"), { recursive: true });
    this.db = new DatabaseSync(path.join(rootDir, "data", "users.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        chat_id TEXT PRIMARY KEY,
        encrypted_wallet TEXT NOT NULL,
        snipe_budget_sol REAL NOT NULL,
        slippage_pct REAL NOT NULL,
        copy_wallets_json TEXT NOT NULL,
        copy_size_mult REAL NOT NULL,
        copy_min_sol REAL NOT NULL,
        copy_auto_sell INTEGER NOT NULL,
        copy_sell_pct REAL NOT NULL,
        paper_mode INTEGER NOT NULL,
        paper_starting_sol REAL NOT NULL,
        real_wallet_configured INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    try {
      this.db.exec("ALTER TABLE users ADD COLUMN real_wallet_configured INTEGER NOT NULL DEFAULT 1");
    } catch { /* column already exists */ }
    this.migrateLegacyVault();
  }

  get(chatId: string): UserProfile | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE chat_id = ?").get(chatId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      chatId: String(row.chat_id),
      walletPrivateKey: this.decrypt(String(row.encrypted_wallet)),
      snipeBudgetSol: Number(row.snipe_budget_sol),
      slippagePct: Number(row.slippage_pct),
      copyTradeWallets: JSON.parse(String(row.copy_wallets_json)) as string[],
      copyTradeSizeMult: Number(row.copy_size_mult),
      copyTradeMinSol: Number(row.copy_min_sol),
      copyTradeAutoSell: Boolean(row.copy_auto_sell),
      copyTradeSellPct: Number(row.copy_sell_pct),
      paperMode: Boolean(row.paper_mode),
      paperStartingSol: Number(row.paper_starting_sol),
      realWalletConfigured: Boolean(row.real_wallet_configured),
      createdAt: String(row.created_at),
    };
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return Number(row.n);
  }

  save(profile: UserProfile): void {
    validatePrivateKey(profile.walletPrivateKey);
    if (!this.get(profile.chatId) && this.count() >= this.maxUsers) {
      throw new Error(`user limit reached (${this.maxUsers})`);
    }
    this.db.prepare(`INSERT OR REPLACE INTO users
      (chat_id, encrypted_wallet, snipe_budget_sol, slippage_pct, copy_wallets_json,
       copy_size_mult, copy_min_sol, copy_auto_sell, copy_sell_pct, paper_mode,
       paper_starting_sol, real_wallet_configured, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(profile.chatId, this.encrypt(profile.walletPrivateKey), profile.snipeBudgetSol,
        profile.slippagePct, JSON.stringify(profile.copyTradeWallets),
        profile.copyTradeSizeMult ?? 0.25, profile.copyTradeMinSol ?? 0.01,
        profile.copyTradeAutoSell ? 1 : 0, profile.copyTradeSellPct ?? 100,
        profile.paperMode ? 1 : 0, profile.paperStartingSol ?? 10,
        profile.realWalletConfigured ? 1 : 0,
        profile.createdAt, new Date().toISOString());
  }

  update(chatId: string, patch: Partial<UserProfile>): UserProfile {
    const current = this.get(chatId);
    if (!current) throw new Error("Profile not configured. Tap Setup first.");
    const next = { ...current, ...patch, chatId };
    this.save(next);
    return next;
  }

  configFor(base: Config, chatId: string): Config {
    const p = this.get(chatId);
    if (!p) throw new Error("Profile not configured. Tap Setup first.");
    return {
      ...base,
      walletPrivateKey: p.walletPrivateKey,
      snipeBudgetLamports: Math.round(p.snipeBudgetSol * 1e9),
      slippagePct: p.slippagePct,
      copyTradeWallets: p.copyTradeWallets,
      copyTradeSizeMult: p.copyTradeSizeMult ?? base.copyTradeSizeMult,
      copyTradeMinSol: p.copyTradeMinSol ?? base.copyTradeMinSol,
      copyTradeAutoSell: p.copyTradeAutoSell ?? true,
      copyTradeSellPct: p.copyTradeSellPct ?? 100,
      paperMode: p.paperMode ?? false,
      paperStartingSol: p.paperStartingSol ?? 10,
      paperFile: path.join(base.rootDir, "data", "users", chatId, "paper.json"),
      ordersFile: path.join(base.rootDir, "data", "users", chatId, "orders.json"),
    };
  }

  private legacyLoad(): Record<string, UserProfile> {
    const envelope = JSON.parse(fs.readFileSync(this.vaultPath, "utf8")) as VaultFile;
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key(), Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plain) as Record<string, UserProfile>;
  }

  private encrypt(secret: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key(), iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const envelope: VaultFile = {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    return JSON.stringify(envelope);
  }

  private decrypt(value: string): string {
    const envelope = JSON.parse(value) as VaultFile;
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key(), Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }

  private migrateLegacyVault(): void {
    if (this.count() > 0 || !fs.existsSync(this.vaultPath)) return;
    const users = this.legacyLoad();
    for (const profile of Object.values(users)) this.save(profile);
    fs.renameSync(this.vaultPath, `${this.vaultPath}.migrated`);
  }

  private key(): Buffer {
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    if (!fs.existsSync(this.keyPath)) {
      fs.writeFileSync(this.keyPath, crypto.randomBytes(32), { mode: 0o600 });
    }
    const key = fs.readFileSync(this.keyPath);
    if (key.length !== 32) throw new Error("invalid user-vault encryption key");
    return key;
  }
}

export function validatePrivateKey(value: string): void {
  normalizeWalletSecret(value);
}

/** Accept a base58 secret key or a BIP-39 phrase and return a base58 secret. */
export function normalizeWalletSecret(value: string): string {
  const input = value.trim();
  const words = input.toLowerCase().split(/\s+/).filter(Boolean);
  if ((words.length === 12 || words.length === 24) && validateMnemonic(words.join(" "))) {
    const seed = mnemonicToSeedSync(words.join(" "));
    const derived = derivePath("m/44'/501'/0'/0'", seed.toString("hex"));
    return bs58.encode(Keypair.fromSeed(derived.key).secretKey);
  }
  try {
    Keypair.fromSecretKey(bs58.decode(input));
    return input;
  } catch {
    throw new Error(
      "Send a valid base58 Solana private key or a valid 12/24-word seed phrase"
    );
  }
}

export function generateWalletSecret(): string {
  return bs58.encode(Keypair.generate().secretKey);
}
