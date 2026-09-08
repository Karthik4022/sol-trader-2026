# sol-trader-2026

A TypeScript Solana trading bot engine: **Pump.fun sniper**, **Jupiter smart swaps**, **limit / take-profit / stop-loss orders**, **wallet copy-trading**, and an optional **Telegram remote control** — all driven from one CLI.

Built with `@solana/web3.js`, `@solana/spl-token`, `commander`, `ws`, and `dotenv`. Requires **Node.js ≥ 20**.

---

## Features

| Area | What it does |
|---|---|
| 🎯 Sniper | Watches Pump.fun via PumpPortal websocket (fastest) or raw RPC `logsSubscribe`, buys new launches instantly with configurable SOL budget and cooldown |
| 🔁 Smart swaps | One `buy`/`sell` command auto-detects the token type and routes through the Pump.fun bonding curve or Jupiter with slippage + priority-fee control |
| 📊 Limit orders | Poll-based `buy-limit` / `sell-limit` / `take-profit` / `stop-loss` engine with an on-disk JSON order store (`data/orders.json`) |
| 👥 Copy trading | Mirrors buys from a comma-separated list of wallets at a fixed size multiplier |
| 🛡 Safety filters | Skips tokens whose mint authority is on, freeze authority is on, holder concentration is too high, etc. |
| 🤖 Telegram bot | Long-polling control bot, chat-restricted by `TG_CHAT_ID`, exposes every command on your phone |
| 🧵 CLI | Single binary-style entry (`node dist/main.js`) with `commander` subcommands |

## Project layout

```
sol-trader-2026/
├── src/
│   ├── main.ts          # CLI entry (commander) — wires every command
│   ├── controller.ts    # shared App class used by both CLI and Telegram
│   ├── config.ts        # env-based configuration (.env / .env.example)
│   ├── wallet.ts        # keypair load / create / derive, data/wallets/
│   ├── rpc.ts           # RPC + WebSocket connection helpers
│   ├── actions.ts       # buy/sell smart routing, amounts, price, PumpToken
│   ├── jupiter.ts       # Jupiter Swap API v1 quotes & execution
│   ├── pump-buy.ts      # Pump.fun bonding-curve buy
│   ├── safety.ts        # token safety filter checks
│   ├── sniper.ts        # Sniper class (PumpPortal feed or RPC logs)
│   ├── copy-trader.ts   # CopyTrader engine
│   ├── limit-order.ts   # LimitOrderEngine + OrderStore + order factory
│   ├── telegram.ts      # TelegramBot (long-polling, TG_CHAT_ID auth)
│   ├── tokens.ts        # raw/UI amount conversion, token balance helpers
│   ├── tx-executor.ts   # sign + send + confirm, priority fee / Jito tip
│   ├── constants.ts     # Pump.fun program ids, misc constants
│   └── logger.ts        # small console logger
├── data/
│   ├── wallets/         # generated keypairs (git-ignored)
│   └── orders.json      # open order store (git-ignored)
├── dist/                # build output (git-ignored)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Quick start

```bash
# 1) install dependencies
npm install

# 2) configure
cp .env.example .env
#    edit .env: RPC_URL, WALLET_PRIVATE_KEY (or leave empty and generate),
#    sniper/copy/order/Telegram settings

# 3) build + generate a wallet (if you did not set WALLET_PRIVATE_KEY)
npm run build
node dist/main.js wallet new main

# 4) check everything
npm run status            # or: node dist/main.js status
```

> **RPC warning** — for sniping, `https://api.mainnet-beta.solana.com` is far too slow.
> Use a paid/private RPC (Helius, Triton, QuickNode, Alchemy…) and set `RPC_URL` accordingly.

## CLI reference

```
node dist/main.js <command>

wallet                          wallet management
  new [label]                     generate a fresh keypair → data/wallets/<label>.json
  show                            print the configured public key
  balance [address]               SOL balance of an address

buy <mint> [solAmount]          buy a token via smart route (curve or Jupiter)
sell <mint> [pct]               sell pct% of holdings (default 100)
price <mint>                    live price in SOL per token
balance [address]               SOL balance (alias: bal)

status                          wallet + RPC + engines summary

snipe [solPerBuy]               run the Pump.fun sniper until Ctrl+C
copy                            run the copy-trader until Ctrl+C
order run                       poll and fill open orders until Ctrl+C
order add <kind> <mint> <trigger> [size]
    kind = buy-limit | sell-limit | take-profit | stop-loss
    buy-limit size = SOL to spend · sell size = pct% of holdings (default 100)
order list | order cancel <id> | order status

bot                             run the Telegram control bot until Ctrl+C
```

Engine commands run in the foreground and stop gracefully on **Ctrl+C**.

## Telegram control bot

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the token.
2. Message your bot once, then find your chat id (e.g. via `@userinfobot`).
3. In `.env` set `TG_BOT_TOKEN` and `TG_CHAT_ID` (used to authorize chats).
4. Start it: `node dist/main.js bot` (or `npm run bot`).

The bot answers: `/buy`, `/sell`, `/price`, `/balance`, `/wallet`, `/status`,
`/snipe on|off|status`, `/copy on|off|status`, `/orders on|off|list|status`,
`/order add|list|cancel`, `/help`. Use `/snipe on 0.2`-style args to override budgets.
Only the chat id listed in `TG_CHAT_ID` may send commands — everyone else is ignored.

## Order kinds

| kind | triggers when | size means |
|---|---|---|
| `buy-limit` | price ≤ trigger | SOL to spend |
| `sell-limit` | price ≥ trigger | % of holdings to sell (default 100) |
| `take-profit` | price ≥ trigger | % of holdings to sell (default 100) |
| `stop-loss` | price ≤ trigger | % of holdings to sell (default 100) |

Sell-side sizes accept plain numbers or `%` (e.g. `50` or `50%`). Open orders persist in
`ORDERS_FILE` and are only executed while `order run` is active.

## Environment variables

See `.env.example` for the full annotated list. Highlights:

| Variable | Default | Purpose |
|---|---|---|
| `RPC_URL` / `WS_URL` | public mainnet | RPC + WebSocket endpoints |
| `WALLET_PRIVATE_KEY` | — | base58 trading key (or generate with `wallet new`) |
| `SNIPE_BUDGET_SOL` | `0.2` | SOL spent per snipe buy |
| `SLIPPAGE_PCT` | `15` | Jupiter swap slippage |
| `PRIORITY_LEVEL` | `high` | `auto/low/medium/high/veryHigh` |
| `MAX_PRIORITY_FEE_LAMPORTS` | `2500000` | hard fee cap (lamports) |
| `JITO_TIP_SOL` | `0` | Jito tip for snipes when > 0 |
| `SNIPER_FEED` | `1` | `1` = PumpPortal ws, `2` = RPC logsSubscribe |
| `COPY_TRADE_WALLETS` | — | comma-separated wallets to mirror |
| `COPY_TRADE_SIZE_MULT` | `0.25` | copy size multiplier |
| `ORDERS_FILE` / `ORDER_POLL_MS` | `data/orders.json` / `4000` | order persistence + poll interval |
| `TG_BOT_TOKEN` / `TG_CHAT_ID` | — | Telegram bot credentials/authorization |
| `SAFETY_*` | see example | mint/freeze authority, holder %, renounce filters |

## Safety & risk

- Token **safety filters** (`SAFETY_*`) skip suspicious launches, but they are **not** a
  guarantee against scams, rugs, or honeypots.
- Meme tokens are extremely volatile; slippage defaults high for a reason.
- Run engines with budgets you are comfortable losing.
- This software is for **educational and research use**. Trading crypto carries real
  financial risk — nothing here is financial advice.

---

# sol-trader-2026 — தமிழ் விளக்கம்

TypeScript-ல் எழுதப்பட்ட **Solana வர்த்தக போட்** (trading bot) இன்ஜின். இது **Pump.fun sniper**,
**Jupiter smart swaps**, **limit / take-profit / stop-loss ஆர்டர்கள்**, **copy-trading**
(வேறு வாலட்டுகளைப் பின்பற்றுதல்), மற்றும் **Telegram மூலம் ரிமோட் கட்டுப்பாடு** — அனைத்தையும் ஒரே CLI-ல் வழங்குகிறது.

**தேவைகள்:** Node.js ≥ 20. சார்புகள்: `@solana/web3.js`, `@solana/spl-token`, `commander`, `ws`, `dotenv`.

## முக்கிய அம்சங்கள்

- **Sniper** — Pump.fun-ல் புதிய டோக்கன்கள் வெளிவந்த உடனே வாங்கும். PumpPortal websocket (`SNIPER_FEED=1`)
  அல்லது RPC `logsSubscribe` (`SNIPER_FEED=2`) மூலம் கண்காணிக்கிறது.
- **Smart swaps** — `buy`/`sell` கட்டளை டோக்கன் வகையை தானாகக் கண்டறிந்து Pump.fun bonding curve
  அல்லது Jupiter வழியாக மாற்று (swap) செய்கிறது.
- **Limit orders** — `buy-limit`, `sell-limit`, `take-profit`, `stop-loss` ஆர்டர்கள்
  குறிப்பிட்ட விலையை அடையும் போது நிரப்பப்படும். ஆர்
