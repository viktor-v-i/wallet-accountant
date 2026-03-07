# Wallet Accountant Agent

A 24/7 AI-powered wallet monitoring agent that watches a Base mainnet wallet and reports transactions via Telegram.

## Architecture

- **monitor.js** — Main entry point. Polls Alchemy every 30s for new transactions across all watched wallets. Handles daily summaries at 8pm.
- **commands.js** — All Telegram bot command handlers. Import db functions as async.
- **analyzer.js** — OpenRouter/Kimi K2.5 integration for categorizing transactions and generating summaries.
- **db.js** — PostgreSQL via `pg` pool. All functions are async. Tables auto-created on startup via `initDb()`.
- **bot.js** — Telegram bot instance (polling mode). Imported by both notify.js and commands.js.
- **notify.js** — Sends Telegram alerts. Respects pause/threshold settings from DB.

## Deployment

- **Platform:** Railway
- **Services:** Node.js service + Postgres — both in the same Railway project
- **Auto-deploy:** Every push to `master` triggers a Railway redeploy
- **Start command:** `npm start` → `node monitor.js`

## Environment Variables (set in Railway dashboard)

| Variable | Description |
|---|---|
| `WALLET_ADDRESS` | Your wallet address on Base mainnet |
| `ALCHEMY_API_KEY` | Alchemy API key for Base mainnet |
| `OPENROUTER_API_KEY` | OpenRouter API key for Kimi K2.5 |
| `MODEL` | `moonshotai/kimi-k2.5` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |
| `POLL_INTERVAL_MS` | Polling interval in ms (default `30000`) |
| `DATABASE_URL` | Auto-injected by Railway from the Postgres plugin via `${{DATABASE_URL}}` |

## Database Schema (PostgreSQL)

- **transactions** — All wallet transactions (hash, timestamp, from/to, value, asset, category, direction, summary)
- **settings** — Key-value store for agent settings (`paused`, `alert_threshold`)
- **watched_wallets** — Additional wallets being monitored
- **daily_summaries** — Stored nightly summaries

## Telegram Commands

| Command | Description |
|---|---|
| `/balance` | Current ETH + USDC balance |
| `/today` | Today's transactions |
| `/recent` | Last 5 transactions with resolved merchant/transfer names |
| `/details` | Full info for last 5 transactions (like /tx but bulk) |
| `/tx <hash>` | Full details of a specific transaction — supports partial hash |
| `/reanalyze <number>` | Re-run Kimi AI on last N transactions (max 50) |
| `/reanalyze <hash>` | Re-run Kimi AI on a specific transaction |
| `/biggest` | Top 5 largest transactions ever |
| `/in` | Incoming transactions (last 24h) |
| `/out` | Outgoing transactions (last 24h) |
| `/search <keyword>` | Search by category, asset or summary |
| `/summary` | AI summary of last 24h |
| `/week` | AI weekly summary |
| `/fees` | Total gas fees paid |
| `/categories` | Visual spending breakdown with % bars — uses merchant category if set, falls back to AI type |
| `/catdetails <category>` | All transactions in a specific category for the last 30 days, with merchant names and total |
| `/topspend` | Spending by category |
| `/watch <address> [label]` | Monitor an additional wallet |
| `/unwatch <address>` | Stop watching a wallet |
| `/alert <amount>` | Only alert for txs above amount (0 = all) |
| `/pause` | Silence all alerts |
| `/resume` | Re-enable alerts |
| `/help` | Full command list |

## Merchant Lookup System

Addresses are resolved to human-readable names via a `merchants` table. Every outgoing transaction triggers a smart prompt flow in Telegram.

### DB Schema
- `address` — wallet address (lowercase, primary key)
- `name` — human label (e.g. "OpenRouter", "Netflix")
- `category` — optional category string
- `type` — `'merchant'` (permanent) or `'one_off'` (labeled but tracked)
- `tx_count` — how many times this address has been paid
- `added_at` — unix timestamp

### Address Type Detection
`getAddressType(address)` uses `alchemy.core.getCode()` to detect EOA vs contract. This is used for the type hint in the prompt message ("smart contract" or "wallet") but does **not** change which buttons are shown — all four buttons always appear.

Own wallets are still auto-detected and skipped entirely — no prompt ever fires for them.

### Prompt Flow
1. **Own wallet** (in `watched_wallets` or = `WALLET_ADDRESS`) → auto-label "Internal Transfer", no prompt
2. **Unknown address** (EOA or contract) → alert sent → inline keyboard with all four options:
   - `🏪 Merchant` → bot asks for a name → saved as `type='merchant'`
   - `👤 Transfer` → bot asks "Who is this?" → saved as `type='transfer'`
   - `🔖 One-off` → bot asks for a name → saved as `type='one_off'`
   - `⏭ Skip` → dismissed
3. **Known one-off** seen again → "You've paid X before (N times). Save as permanent merchant?"
   - `✅ Yes` → `promoteMerchant()` updates type to `'merchant'`
   - `🔖 Keep as one-off` → dismissed, tx_count incremented
4. **Known merchant or transfer** → no prompt, auto-labeled silently forever

> Note: All four buttons are always shown regardless of address type. The address type (EOA/contract) only appears as a hint in the prompt message. This lets the user override the suggestion — e.g. an EOA payment address used by a business can still be labeled as a Merchant.

### Smart Filters (prompt only fires if):
- Transaction is **outgoing**
- Amount is **above alert threshold**
- Alerts are **not paused**
- Address is **not already a permanent merchant or transfer**

### Conversation State
Multi-step naming ("what do you want to call this?") is handled by an in-memory `Map` in `commands.js`:
```js
const pendingStates = new Map(); // chatId -> { action, address }
```
The `bot.on('message', ...)` handler checks this map before processing any non-command text message. State is cleared after the user replies.

### Telegram Commands
| Command | Description |
|---|---|
| `/merchant <address> <name> [category]` | Manually label an address — name is display name, category is your spending bucket (e.g. API-Keys) |
| `/merchants` | List all labeled addresses (merchants + one-offs + transfers) |
| `/unmerchant <address>` | Remove a label — use then re-add to correct a mistake |

### Key DB Functions
- `upsertMerchant(address, name, category, type)` — insert or update (`type`: `'merchant'`, `'one_off'`, `'transfer'`, `'internal'`)
- `getMerchant(address)` — lookup single address
- `incrementMerchantCount(address)` — called when a one-off is seen again
- `promoteMerchant(address)` — upgrades one-off to permanent merchant
- `getAllMerchants()` — list all for `/merchants` command
- `removeMerchant(address)` — delete label
- `updateTransactionAnalysis(hash, category, summary)` — used by `/reanalyze` to overwrite AI fields
- `getTransactionByHash(hash)` — partial/case-insensitive hash lookup for `/tx`

### Basescan Auto-lookup
On every new transaction, `lookupMerchant()` in `monitor.js` first checks the local DB, then falls back to the Basescan API to auto-resolve contract names. Results are saved to the DB so the API is only hit once per address.

### Category Logic
Both `/categories` and `/catdetails` use merchant category over AI type:
- If a transaction's `to_address` has a merchant with a `category` set → use that category
- Otherwise → fall back to the AI-assigned `type` (Purchase, Transfer, etc.)
- This means labeling merchants with categories progressively improves the breakdown over time

`getTransactionsByCategory(category, since)` in `db.js` does a LEFT JOIN on the merchants table and uses `COALESCE(NULLIF(m.category, ''), t.category)` to resolve the effective category. Case-insensitive match via `ILIKE`.

`getSpendingByCategory()` uses the same join logic for `/categories` and `/topspend`.

### Transaction Detail Format
`/details` and `/tx` both use the `formatTxDetail()` helper in `commands.js`. It shows:
- **Type** — AI-assigned transaction type (Purchase, Transfer, DeFi, etc.) from Kimi
- **Merchant Category** — user-assigned spending bucket from the merchants table (only shown if set)

These are intentionally separate — Kimi owns Type, the user owns Merchant Category.

### DB Migration Notes
The `merchants` table was originally created without `type` and `tx_count` columns. `initDb()` runs `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on every startup to migrate existing deployments safely.

## Key Technical Notes

- **Circular import:** `commands.js` imports `{ alchemy, WALLET }` from `monitor.js` and `monitor.js` imports `{ setupCommands }` from `commands.js`. This works in Node ESM but be careful adding new cross-imports.
- **All DB functions are async** — always `await` them. SQLite was replaced with PostgreSQL, so the sync better-sqlite3 patterns no longer apply.
- **USDC contract on Base mainnet:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **Bot runs in polling mode** — only one instance can run at a time. If you run locally while Railway is live, you'll get a 409 Telegram conflict error.
- **MetaMask debit card** purchases show up as on-chain transactions and are caught automatically.
- **Railway CLI** — install with `npm i -g @railway/cli`, authenticate with `railway login`. Link to your project with `railway link`.

## Local Development

```bash
cd wallet-agent
cp .env.example .env  # fill in your keys
npm install
node monitor.js
```

Stop Railway service before running locally to avoid Telegram 409 conflicts.

## Adding New Commands

1. Add the handler in `commands.js` inside `setupCommands()`
2. Add any new DB queries to `db.js` as async functions
3. Add the command to the `/help` handler in `commands.js`
4. Push to GitHub — Railway auto-deploys

## Updating the Model

Change the `MODEL` environment variable in Railway dashboard. Any OpenRouter model ID works, e.g. `anthropic/claude-sonnet-4-5`, `openai/gpt-4o`, `moonshotai/kimi-k2.5`.
