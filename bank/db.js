import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id SERIAL PRIMARY KEY,
      dedup_hash TEXT UNIQUE NOT NULL,
      date DATE NOT NULL,
      amount_sek NUMERIC(12,2) NOT NULL,
      sender TEXT,
      recipient TEXT,
      name TEXT,
      description TEXT,
      balance_sek NUMERIC(12,2),
      currency TEXT DEFAULT 'SEK',
      direction TEXT NOT NULL,
      category TEXT,
      tag TEXT,
      ai_summary TEXT,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_merchants (
      name_key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      category TEXT,
      tx_count INT DEFAULT 1,
      added_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
  `);
}

// Generate a deduplication hash from date + amount + description
export function dedupHash(date, amount, description) {
  return `${date}|${amount}|${(description || '').trim()}`;
}

export async function insertTransaction(tx) {
  const res = await pool.query(
    `INSERT INTO bank_transactions
      (dedup_hash, date, amount_sek, sender, recipient, name, description, balance_sek, currency, direction, category, tag, ai_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (dedup_hash) DO NOTHING
     RETURNING *`,
    [
      tx.dedup_hash,
      tx.date,
      tx.amount_sek,
      tx.sender || null,
      tx.recipient || null,
      tx.name || null,
      tx.description || null,
      tx.balance_sek || null,
      tx.currency || 'SEK',
      tx.direction,
      tx.category || null,
      tx.tag || null,
      tx.ai_summary || null,
    ]
  );
  return res.rows[0] || null; // null = duplicate, already exists
}

export async function updateAnalysis(dedupHash, category, tag, summary) {
  await pool.query(
    `UPDATE bank_transactions SET category=$1, tag=$2, ai_summary=$3 WHERE dedup_hash=$4`,
    [category, tag, summary, dedupHash]
  );
}

export async function getTransactionsSince(unixTimestamp) {
  const res = await pool.query(
    `SELECT * FROM bank_transactions WHERE created_at >= $1 ORDER BY date DESC, created_at DESC`,
    [unixTimestamp]
  );
  return res.rows;
}

export async function getTransactionsByDate(dateStr) {
  const res = await pool.query(
    `SELECT * FROM bank_transactions WHERE date = $1 ORDER BY created_at DESC`,
    [dateStr]
  );
  return res.rows;
}

export async function getRecentTransactions(limit = 10) {
  const res = await pool.query(
    `SELECT * FROM bank_transactions ORDER BY date DESC, created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function getTransactionsByTag(tag, since) {
  const res = await pool.query(
    `SELECT * FROM bank_transactions WHERE tag = $1 AND created_at >= $2 ORDER BY date DESC`,
    [tag, since]
  );
  return res.rows;
}

export async function searchTransactions(keyword) {
  const res = await pool.query(
    `SELECT * FROM bank_transactions
     WHERE description ILIKE $1 OR name ILIKE $1 OR category ILIKE $1 OR ai_summary ILIKE $1
     ORDER BY date DESC LIMIT 20`,
    [`%${keyword}%`]
  );
  return res.rows;
}

export async function getSpendingByCategory(since) {
  const res = await pool.query(
    `SELECT category, COUNT(*) as count, SUM(ABS(amount_sek)) as total
     FROM bank_transactions
     WHERE direction = 'out' AND created_at >= $1 AND category IS NOT NULL
     GROUP BY category
     ORDER BY total DESC`,
    [since]
  );
  return res.rows;
}

export async function upsertMerchant(nameKey, displayName, category) {
  await pool.query(
    `INSERT INTO bank_merchants (name_key, display_name, category)
     VALUES ($1, $2, $3)
     ON CONFLICT (name_key) DO UPDATE
     SET display_name = EXCLUDED.display_name,
         category = COALESCE(NULLIF(EXCLUDED.category,''), bank_merchants.category),
         tx_count = bank_merchants.tx_count + 1`,
    [nameKey.toLowerCase(), displayName, category || '']
  );
}

export async function getMerchant(nameKey) {
  const res = await pool.query(
    `SELECT * FROM bank_merchants WHERE name_key = $1`,
    [nameKey.toLowerCase()]
  );
  return res.rows[0] || null;
}

export async function getAllMerchants() {
  const res = await pool.query(`SELECT * FROM bank_merchants ORDER BY tx_count DESC`);
  return res.rows;
}
