import { dedupHash, insertTransaction, updateAnalysis } from './db.js';
import { analyzeTransaction } from './analyzer.js';

// Parse Nordea CSV export (tab-separated, Swedish locale)
// Columns: Bokföringsdag, Belopp, Avsändare, Mottagare, Namn, Rubrik, Saldo, Valuta
export function parseNordeaCSV(content) {
  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  // Find the header line — Nordea sometimes prepends account info rows
  const headerIndex = lines.findIndex(l =>
    l.toLowerCase().includes('bokföringsdag') || l.toLowerCase().includes('bokforingsdag')
  );
  if (headerIndex === -1) throw new Error('Could not find CSV header row (Bokföringsdag)');

  const rows = lines.slice(headerIndex + 1);
  const transactions = [];

  for (const row of rows) {
    const cols = row.split('\t');
    if (cols.length < 6) continue;

    const [dateRaw, amountRaw, sender, recipient, name, description, balanceRaw, currency] = cols;

    const date = dateRaw.trim().replace(/\//g, '-'); // 2026/03/28 → 2026-03-28
    const amount = parseFloat(amountRaw.trim().replace(',', '.'));
    const balance = balanceRaw ? parseFloat(balanceRaw.trim().replace(',', '.')) : null;

    if (!date || isNaN(amount)) continue;

    const hash = dedupHash(date, amount, description);

    transactions.push({
      dedup_hash: hash,
      date,
      amount_sek: amount,
      sender: sender?.trim() || null,
      recipient: recipient?.trim() || null,
      name: name?.trim() || null,
      description: description?.trim() || null,
      balance_sek: isNaN(balance) ? null : balance,
      currency: currency?.trim() || 'SEK',
      direction: amount < 0 ? 'out' : 'in',
    });
  }

  return transactions;
}

// Ingest parsed transactions: deduplicate, insert, run AI analysis
// Returns { inserted, duplicates, failed }
export async function ingestTransactions(parsed, onProgress) {
  const inserted = [];
  const duplicates = [];
  const failed = [];

  for (const tx of parsed) {
    try {
      const row = await insertTransaction(tx);
      if (!row) {
        duplicates.push(tx);
        continue;
      }

      // Run AI analysis on new transactions
      try {
        const analysis = await analyzeTransaction(row);
        await updateAnalysis(row.dedup_hash, analysis.category, analysis.tag, analysis.summary);
        row.category = analysis.category;
        row.tag = analysis.tag;
        row.ai_summary = analysis.summary;
      } catch (err) {
        console.error(`AI analysis failed for ${row.dedup_hash}:`, err.message);
        // Transaction is still inserted, just without analysis
      }

      inserted.push(row);
      if (onProgress) onProgress(row);
    } catch (err) {
      console.error(`Insert failed for ${tx.dedup_hash}:`, err.message);
      failed.push(tx);
    }
  }

  return { inserted, duplicates, failed };
}
