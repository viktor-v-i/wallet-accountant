import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      hash TEXT PRIMARY KEY,
      block_number INTEGER,
      timestamp INTEGER,
      from_address TEXT,
      to_address TEXT,
      value_eth REAL,
      value_usd REAL,
      asset TEXT,
      category TEXT,
      direction TEXT,
      summary TEXT,
      raw TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_summaries (
      date TEXT PRIMARY KEY,
      summary TEXT,
      total_in_usd REAL,
      total_out_usd REAL,
      tx_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS watched_wallets (
      address TEXT PRIMARY KEY,
      label TEXT,
      added_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS merchants (
      address TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      type TEXT DEFAULT 'merchant',
      tx_count INTEGER DEFAULT 1,
      added_at INTEGER
    );
  `);

  // Migrate existing merchants table if columns are missing
  await pool.query(`
    ALTER TABLE merchants ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'merchant';
    ALTER TABLE merchants ADD COLUMN IF NOT EXISTS tx_count INTEGER DEFAULT 1;
  `);
}

// Transactions
export async function insertTransaction(tx) {
  await pool.query(`
    INSERT INTO transactions
    (hash, block_number, timestamp, from_address, to_address, value_eth, value_usd, asset, category, direction, summary, raw)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (hash) DO NOTHING
  `, [tx.hash, tx.block_number, tx.timestamp, tx.from_address, tx.to_address,
      tx.value_eth, tx.value_usd, tx.asset, tx.category, tx.direction, tx.summary, tx.raw]);
}

export async function getRecentTransactions(limit = 20) {
  const { rows } = await pool.query('SELECT * FROM transactions ORDER BY timestamp DESC LIMIT $1', [limit]);
  return rows;
}

export async function getTransactionsSince(timestamp) {
  const { rows } = await pool.query('SELECT * FROM transactions WHERE timestamp >= $1 ORDER BY timestamp DESC', [timestamp]);
  return rows;
}

export async function isKnownTransaction(hash) {
  const { rows } = await pool.query('SELECT 1 FROM transactions WHERE hash = $1', [hash]);
  return rows.length > 0;
}

export async function updateTransactionAnalysis(hash, category, summary) {
  await pool.query(
    'UPDATE transactions SET category = $1, summary = $2 WHERE hash = $3',
    [category, summary, hash]
  );
}

export async function getTransactionByHash(hash) {
  const { rows } = await pool.query(
    'SELECT * FROM transactions WHERE hash ILIKE $1 OR hash ILIKE $2',
    [`${hash.toLowerCase()}%`, `%${hash.toLowerCase()}%`]
  );
  return rows[0] || null;
}

export async function getBiggestTransactions(limit = 5) {
  const { rows } = await pool.query('SELECT * FROM transactions ORDER BY value_eth DESC LIMIT $1', [limit]);
  return rows;
}

export async function searchTransactions(keyword) {
  const q = `%${keyword}%`;
  const { rows } = await pool.query(`
    SELECT * FROM transactions
    WHERE category ILIKE $1 OR summary ILIKE $2 OR asset ILIKE $3
    ORDER BY timestamp DESC LIMIT 20
  `, [q, q, q]);
  return rows;
}

export async function getTransactionsByCategory(category, since) {
  const { rows } = await pool.query(`
    SELECT t.*, COALESCE(NULLIF(m.category, ''), t.category) as resolved_category,
           m.name as merchant_name
    FROM transactions t
    LEFT JOIN merchants m ON m.address = t.to_address
    WHERE t.direction = 'out'
      AND t.timestamp >= $1
      AND COALESCE(NULLIF(m.category, ''), t.category) ILIKE $2
    ORDER BY t.timestamp DESC
  `, [since, category]);
  return rows;
}

export async function getSpendingByCategory() {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(NULLIF(m.category, ''), t.category) as category,
      SUM(t.value_eth) as total,
      COUNT(*) as count
    FROM transactions t
    LEFT JOIN merchants m ON m.address = t.to_address
    WHERE t.direction = 'out'
    GROUP BY COALESCE(NULLIF(m.category, ''), t.category)
    ORDER BY total DESC
  `);
  return rows;
}

// Daily summaries
export async function saveDailySummary(date, summary, totalIn, totalOut, txCount) {
  await pool.query(`
    INSERT INTO daily_summaries (date, summary, total_in_usd, total_out_usd, tx_count)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (date) DO UPDATE SET summary=$2, total_in_usd=$3, total_out_usd=$4, tx_count=$5
  `, [date, summary, totalIn, totalOut, txCount]);
}

// Settings
export async function getSetting(key, defaultValue = null) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length > 0 ? rows[0].value : defaultValue;
}

export async function setSetting(key, value) {
  await pool.query(`
    INSERT INTO settings (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = $2
  `, [key, String(value)]);
}

// Watched wallets
export async function addWatchedWallet(address, label = '') {
  await pool.query(`
    INSERT INTO watched_wallets (address, label, added_at) VALUES ($1, $2, $3)
    ON CONFLICT (address) DO NOTHING
  `, [address.toLowerCase(), label, Math.floor(Date.now() / 1000)]);
}

export async function removeWatchedWallet(address) {
  await pool.query('DELETE FROM watched_wallets WHERE address = $1', [address.toLowerCase()]);
}

export async function getWatchedWallets() {
  const { rows } = await pool.query('SELECT * FROM watched_wallets');
  return rows;
}

// Merchants
export async function upsertMerchant(address, name, category = '', type = 'merchant') {
  await pool.query(`
    INSERT INTO merchants (address, name, category, type, tx_count, added_at)
    VALUES ($1, $2, $3, $4, 1, $5)
    ON CONFLICT (address) DO UPDATE SET name = $2, category = $3, type = $4
  `, [address.toLowerCase(), name, category, type, Math.floor(Date.now() / 1000)]);
}

export async function incrementMerchantCount(address) {
  await pool.query(`
    UPDATE merchants SET tx_count = tx_count + 1 WHERE address = $1
  `, [address.toLowerCase()]);
}

export async function promoteMerchant(address) {
  await pool.query(`
    UPDATE merchants SET type = 'merchant' WHERE address = $1
  `, [address.toLowerCase()]);
}

export async function getMerchant(address) {
  const { rows } = await pool.query('SELECT * FROM merchants WHERE address = $1', [address.toLowerCase()]);
  return rows[0] || null;
}

export async function getAllMerchants() {
  const { rows } = await pool.query('SELECT * FROM merchants ORDER BY name ASC');
  return rows;
}

export async function removeMerchant(address) {
  await pool.query('DELETE FROM merchants WHERE address = $1', [address.toLowerCase()]);
}

export default pool;
