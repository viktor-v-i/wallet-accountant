# Wallet Accountant Agent — What We Built & How to Set It Up

## What Is This?

A 24/7 AI-powered wallet monitor that watches your Base mainnet crypto wallet and reports every transaction to you via Telegram — in plain English. It catches everything including MetaMask debit card purchases, labels merchants, categorizes your spending, and lets you query your financial history through simple chat commands.

Built with Node.js, deployed on Railway, powered by Kimi K2.5 via OpenRouter.

---

## What It Does

- **Instant alerts** — every incoming and outgoing transaction hits your Telegram within 30 seconds
- **AI summaries** — Kimi K2.5 categorizes and describes each transaction in plain English
- **Merchant labeling** — after each new payment, the bot asks what it was for. Tap a button, type a name, done. Future payments to that address are auto-labeled
- **Spending breakdown** — `/categories` shows a visual % breakdown of where your money goes
- **14+ commands** — query balances, search transactions, get weekly summaries, and more
- **MetaMask debit card** — confirmed to work. Card purchases show up as on-chain transactions and are caught automatically
- **Runs 24/7 in the cloud** — no PC required once deployed to Railway

---

## The Stack

| Component | Tool | Cost |
|---|---|---|
| Blockchain data | Alchemy (free tier) | Free |
| AI analysis | Kimi K2.5 via OpenRouter | ~$0.60/1M tokens |
| Notifications | Telegram Bot API | Free |
| Hosting | Railway | ~$0-5/month |
| Database | PostgreSQL on Railway | Included |
| Code | Node.js ESM | Free |

---

## How to Set It Up

### 1. Prerequisites
- A MetaMask wallet on **Base mainnet** with some USDC
- A GitHub account
- Accounts on: Alchemy, OpenRouter, Railway, Telegram

### 2. Get Your API Keys

**Alchemy**
1. Sign up at alchemy.com
2. Create a new app → select **Base** → **Mainnet**
3. Copy the API key

**OpenRouter**
1. Sign up at openrouter.ai
2. Go to Keys → create a new key
3. Add some credit ($5 is plenty to start)

**Telegram Bot**
1. Open Telegram → search `@BotFather`
2. Send `/newbot` → follow prompts → copy the token
3. Start your bot, send it any message
4. Get your chat ID: visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` — look for `"id"` inside `"chat"`

### 3. Clone & Configure

```bash
git clone https://github.com/viktor-v-i/wallet-agent
cd wallet-agent
npm install
cp .env.example .env
```

Fill in `.env`:
```
WALLET_ADDRESS=0xYourWalletAddress
ALCHEMY_API_KEY=your_alchemy_key
OPENROUTER_API_KEY=sk-or-v1-...
MODEL=moonshotai/kimi-k2.5
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
POLL_INTERVAL_MS=30000
```

### 4. Deploy to Railway

1. Push the repo to your own GitHub account
2. Go to railway.app → New Project → Deploy from GitHub repo
3. Add all the `.env` variables in the Railway dashboard
4. Add a **PostgreSQL** database to the same project — Railway auto-injects `DATABASE_URL`
5. Set the start command to `npm start`
6. Deploy — watch the logs for `Database ready` and `Telegram commands registered`

### 5. Test It

Send `/help` to your Telegram bot. You should get the full command list back.

Make a small transaction from your wallet — you'll get an alert within 30 seconds and a prompt asking you to label the merchant.

---

## Key Commands

| Command | What it does |
|---|---|
| `/balance` | Current ETH + USDC balance |
| `/recent` | Last 5 transactions |
| `/details` | Full info for last 5 transactions |
| `/today` | Today's transactions |
| `/week` | AI weekly summary |
| `/categories` | Visual spending breakdown |
| `/catdetails <category>` | All transactions in a category (30 days) |
| `/tx <hash>` | Look up a specific transaction |
| `/reanalyze <number>` | Re-run AI on last N transactions |
| `/merchant <address> <name> <category>` | Manually label an address |
| `/merchants` | List all labeled merchants |
| `/alert <amount>` | Only alert above a threshold |
| `/pause` / `/resume` | Silence or re-enable alerts |

---

## Built With Claude Code

This entire project was built conversationally with Claude Code in a single session — no manual coding required. If you want to extend it, open the project in Claude Code and it will read `CLAUDE.md` for full context before making any changes.

To add a new command, just ask Claude to add it — it knows the architecture, the DB schema, and all the gotchas.
