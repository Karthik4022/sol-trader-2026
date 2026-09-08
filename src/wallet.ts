import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";
import { logger } from "./logger.js";

/**
 * Wallets are stored as data/wallets/<label>.json (base58 secret key) and the
 * active one is tracked by data/wallets/.active. WALLET_PRIVATE_KEY in .env
 * still wins over every file-backed wallet.
 */
export const WALLET_DIR = "data/wallets";
const ACTIVE_FILE = ".active";

const LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/;

function assertValidLabel(label: string): void {
  if (!LABEL_RE.test(label)) {
    throw new Error(`invalid wallet label "${label}" (use letters, digits, _ or -, max 64 chars)`);
  }
}

/** Absolute path of the secret file for a wallet label. */
export function walletFile(cfgRootDir: string, label = "default"): string {
  assertValidLabel(label);
  return path.join(cfgRootDir, WALLET_DIR, `${label}.json`);
}

/** Labels of all wallets that exist on disk, sorted. */
export function walletLabels(cfgRootDir: string): string[] {
  const dir = path.join(cfgRootDir, WALLET_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((l) => LABEL_RE.test(l))
    .sort();
}

/** Label of the active wallet (persisted in data/wallets/.active). */
export function activeWalletLabel(cfgRootDir: string): string {
  let pointerLabel = "";
  try {
    pointerLabel = fs.readFileSync(path.join(cfgRootDir, WALLET_DIR, ACTIVE_FILE), "utf8").trim();
  } catch {
    // no pointer yet
  }
  const labels = walletLabels(cfgRootDir);
  if (pointerLabel && labels.includes(pointerLabel)) return pointerLabel;
  // Auto-heal: no valid pointer but exactly one wallet exists -> use it, so
  // `wallet show` works even before any `wallet new` has been run.
  if (labels.length === 1) return labels[0];
  return "default";
}

/** Persists the active wallet label. */
export function setActiveWallet(cfgRootDir: string, label: string): void {
  assertValidLabel(label);
  const dir = path.join(cfgRootDir, WALLET_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ACTIVE_FILE), `${label}\n`, { mode: 0o600 });
}

export function walletExists(cfgRootDir: string, label: string): boolean {
  return fs.existsSync(walletFile(cfgRootDir, label));
}

/** True when the active wallet has a secret file on disk. */
export function hasWalletFile(cfgRootDir: string): boolean {
  return walletExists(cfgRootDir, activeWalletLabel(cfgRootDir));
}

/** Loads the trading keypair: env WALLET_PRIVATE_KEY wins, else the active local file. */
export function loadKeypair(cfgRootDir: string, envKey: string): Keypair {
  const b58 = envKey || loadKeypairFile(cfgRootDir);
  if (!b58) {
    const labels = walletLabels(cfgRootDir);
    const hint = labels.length
      ? `Wallets on disk: ${labels.join(", ")}. Set WALLET_PRIVATE_KEY in .env, or create a new active wallet with: node dist/main.js wallet new <label>`
      : "Run: node dist/main.js wallet new [label]";
    throw new Error(
      `No wallet configured. Set WALLET_PRIVATE_KEY in .env or run: node dist/main.js wallet new. ${hint}`
    );
  }
  try {
    const decoded = bs58.decode(b58);
    return Keypair.fromSecretKey(decoded);
  } catch (e) {
    throw new Error(`Invalid WALLET_PRIVATE_KEY (must be base58 64 bytes): ${(e as Error).message}`);
  }
}

function loadKeypairFile(cfgRootDir: string): string {
  const label = activeWalletLabel(cfgRootDir);
  const p = walletFile(cfgRootDir, label);
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8").trim();
}

/**
 * Generates a fresh keypair under data/wallets/<label>.json and makes it the
 * active trading wallet. Returns the new keypair.
 */
export function createKeypairFile(cfgRootDir: string, label = "default"): Keypair {
  assertValidLabel(label);
  const kp = Keypair.generate();
  const file = walletFile(cfgRootDir, label);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bs58.encode(kp.secretKey), { mode: 0o600 });
  setActiveWallet(cfgRootDir, label);
  logger.info("wallet", `Created ${label} wallet: ${kp.publicKey.toBase58()} -> ${file}`);
  logger.warn("wallet", `Secret saved to ${file}. NEVER share it, never use it on a machine you do not control.`);
  return kp;
}

export function toPublicKey(v: string): PublicKey {
  try {
    return new PublicKey(v);
  } catch {
    throw new Error(`Invalid public key: ${v}`);
  }
}



