# Going Public — How to Create a Public Template Repo

## The Right Approach: Two Repos

Do NOT make this repo public as-is. Instead, create a separate public repo that is a clean template version.

- **This repo (private)** — your live deployment. Keep it private. Contains your real wallet address, Telegram chat ID, and full CLAUDE.md with personal context. Never make this public.
- **New public repo** — a scrubbed template for others. No personal data. Placeholders everywhere.

---

## Step-by-Step: Creating the Public Repo

### 1. Create a fresh clone

```bash
git clone https://github.com/viktor-v-i/wallet-agent wallet-agent-public
cd wallet-agent-public
```

### 2. Remove the git history (so your old commits with personal details don't come along)

```bash
rm -rf .git
git init
git add .
git commit -m "Initial commit — wallet accountant agent template"
```

### 3. Scrub these files before pushing

**CLAUDE.md** — replace all personal data with placeholders:
- `0xe20084489aDD7f5781633FF6a5e78Fb99e68D0C1` → `0xYourWalletAddress`
- `6365486214` (Telegram chat ID) → `your_chat_id`
- `qbcX...` (Alchemy key hint) → remove entirely
- `7696891013:AAH...` (any token fragments) → remove entirely
- Railway project names (`agent-accountant`, `zucchini-illumination`) → remove or genericize

**GOING_PUBLIC.md** (this file) — keep it, it's useful for others too.

**EXPLAINER.md** — already clean, no changes needed.

**.env.example** — verify it only contains placeholder values, no real keys.

**.env** — must be in `.gitignore` and must NOT be committed. Double-check.

### 4. Files to delete from the public repo

```bash
rm wallet-agent.service   # contains local machine paths
rm GOING_PUBLIC.md        # optional — or keep for transparency
```

### 5. Rotate your credentials after going public (best practice)

Even if the keys were never committed, rotate these as a precaution:
- Alchemy API key — regenerate in the Alchemy dashboard
- Telegram bot token — use @BotFather: `/revoke` then `/token`
- OpenRouter key — regenerate in the OpenRouter dashboard
- Update the new keys in your Railway dashboard

### 6. Create the public GitHub repo

```bash
gh repo create wallet-accountant --public --source=. --push
```

---

## What Stays Private (Never Crosses Over)

| Data | Where it lives | Action |
|---|---|---|
| Real wallet address | Private repo CLAUDE.md + .env | Never copy to public |
| Telegram chat ID | Private repo CLAUDE.md + .env | Never copy to public |
| API keys | .env only (gitignored) | Rotate after going public |
| Railway project names | Private repo CLAUDE.md | Strip from public CLAUDE.md |

---

## For Future Claude Sessions on the Public Repo

If you open Claude Code in the public repo, it will read the scrubbed CLAUDE.md. That's fine — the architecture docs are still fully useful. Just no personal data.

If you want Claude to also have your private context while working on the public template, work from the private repo instead and reference the public one only for publishing.
