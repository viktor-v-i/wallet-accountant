import { bot } from './bot.js';
import { generateSummary } from './analyzer.js';
import {
  getRecentTransactions, getTransactionsSince, getTransactionsByDate,
  getTransactionsByTag, searchTransactions, getSpendingByCategory,
  getAllMerchants, upsertMerchant,
} from './db.js';
import { parseNordeaCSV, ingestTransactions } from './ingest.js';
import https from 'https';

const CHAT_ID = process.env.BANK_TELEGRAM_CHAT_ID;

function tagEmoji(tag) {
  if (tag === 'wasteful') return '🔴';
  if (tag === 'questionable') return '🟡';
  return '🟢';
}

function formatTx(tx) {
  const dir = tx.direction === 'in' ? '⬇️' : '⬆️';
  const amount = Math.abs(parseFloat(tx.amount_sek)).toFixed(2);
  const emoji = tagEmoji(tx.tag);
  const desc = tx.description || tx.name || 'Unknown';
  return `${dir} ${emoji} *${amount} SEK* — ${tx.category || '?'}\n_${desc}_`;
}

function sinceWeek() {
  return Math.floor(Date.now() / 1000) - 7 * 86400;
}

function sinceMonth() {
  return Math.floor(Date.now() / 1000) - 30 * 86400;
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

async function downloadFile(fileId) {
  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.BANK_TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

export function setupCommands() {

  // CSV file upload handler
  bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(CHAT_ID)) return;

    const doc = msg.document;
    if (!doc.file_name?.endsWith('.csv') && doc.mime_type !== 'text/csv') {
      await bot.sendMessage(chatId, 'Send a .csv file exported from Nordea.');
      return;
    }

    const status = await bot.sendMessage(chatId, '📂 Reading CSV...');

    try {
      const content = await downloadFile(doc.file_id);
      const parsed = parseNordeaCSV(content);

      if (parsed.length === 0) {
        await bot.editMessageText('No transactions found in this file.', {
          chat_id: chatId, message_id: status.message_id,
        });
        return;
      }

      await bot.editMessageText(
        `📊 Found *${parsed.length}* transactions. Running AI analysis...`,
        { chat_id: chatId, message_id: status.message_id, parse_mode: 'Markdown' }
      );

      const { inserted, duplicates } = await ingestTransactions(parsed);

      if (inserted.length === 0) {
        await bot.editMessageText(
          `✅ All *${duplicates.length}* transactions already in the database.`,
          { chat_id: chatId, message_id: status.message_id, parse_mode: 'Markdown' }
        );
        return;
      }

      // Build digest
      const out = inserted.filter(t => t.direction === 'out');
      const inn = inserted.filter(t => t.direction === 'in');
      const wasteful = out.filter(t => t.tag === 'wasteful');
      const questionable = out.filter(t => t.tag === 'questionable');
      const acceptable = out.filter(t => t.tag === 'acceptable');
      const totalOut = out.reduce((s, t) => s + Math.abs(parseFloat(t.amount_sek)), 0);
      const totalIn = inn.reduce((s, t) => s + Math.abs(parseFloat(t.amount_sek)), 0);

      let digest = `✅ *${inserted.length} new transactions imported*`;
      if (duplicates.length > 0) digest += ` (${duplicates.length} skipped — already seen)`;
      digest += `\n\n`;
      digest += `⬆️ Spent: *${totalOut.toFixed(2)} SEK* across ${out.length} transactions\n`;
      digest += `⬇️ Received: *${totalIn.toFixed(2)} SEK*\n\n`;
      digest += `🟢 Acceptable: ${acceptable.length}   🟡 Questionable: ${questionable.length}   🔴 Wasteful: ${wasteful.length}`;

      if (wasteful.length > 0) {
        digest += `\n\n*Wasteful:*\n`;
        digest += wasteful.slice(0, 5).map(t =>
          `• ${Math.abs(parseFloat(t.amount_sek)).toFixed(2)} SEK — ${t.ai_summary || t.description}`
        ).join('\n');
        if (wasteful.length > 5) digest += `\n_...and ${wasteful.length - 5} more. Use /wasteful to see all._`;
      }

      await bot.editMessageText(digest, {
        chat_id: chatId, message_id: status.message_id, parse_mode: 'Markdown',
      });

    } catch (err) {
      await bot.editMessageText(`❌ Error: ${err.message}`, {
        chat_id: chatId, message_id: status.message_id,
      });
    }
  });

  // /today
  bot.onText(/\/today/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const txs = await getTransactionsByDate(todayStr());
      if (txs.length === 0) {
        await bot.sendMessage(chatId, 'No transactions for today.');
        return;
      }
      const lines = txs.map(formatTx).join('\n\n');
      await bot.sendMessage(chatId, `*Today — ${todayStr()}*\n\n${lines}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /recent
  bot.onText(/\/recent/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const txs = await getRecentTransactions(10);
      if (txs.length === 0) {
        await bot.sendMessage(chatId, 'No transactions yet.');
        return;
      }
      const lines = txs.map(t => `${t.date}  ${formatTx(t)}`).join('\n\n');
      await bot.sendMessage(chatId, `*Last 10 transactions:*\n\n${lines}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /wasteful
  bot.onText(/\/wasteful/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const txs = await getTransactionsByTag('wasteful', sinceMonth());
      if (txs.length === 0) {
        await bot.sendMessage(chatId, '🟢 No wasteful transactions in the last 30 days.');
        return;
      }
      const total = txs.reduce((s, t) => s + Math.abs(parseFloat(t.amount_sek)), 0);
      const lines = txs.map(t =>
        `🔴 *${Math.abs(parseFloat(t.amount_sek)).toFixed(2)} SEK* — ${t.category}\n_${t.ai_summary || t.description}_\n${t.date}`
      ).join('\n\n');
      await bot.sendMessage(chatId,
        `*Wasteful spending (last 30 days)*\nTotal: *${total.toFixed(2)} SEK*\n\n${lines}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /questionable
  bot.onText(/\/questionable/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const txs = await getTransactionsByTag('questionable', sinceMonth());
      if (txs.length === 0) {
        await bot.sendMessage(chatId, '🟢 No questionable transactions in the last 30 days.');
        return;
      }
      const total = txs.reduce((s, t) => s + Math.abs(parseFloat(t.amount_sek)), 0);
      const lines = txs.map(t =>
        `🟡 *${Math.abs(parseFloat(t.amount_sek)).toFixed(2)} SEK* — ${t.category}\n_${t.ai_summary || t.description}_\n${t.date}`
      ).join('\n\n');
      await bot.sendMessage(chatId,
        `*Questionable spending (last 30 days)*\nTotal: *${total.toFixed(2)} SEK*\n\n${lines}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /categories
  bot.onText(/\/categories/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const cats = await getSpendingByCategory(sinceMonth());
      if (cats.length === 0) {
        await bot.sendMessage(chatId, 'No spending data yet.');
        return;
      }
      const totalOut = cats.reduce((s, c) => s + parseFloat(c.total), 0);
      const lines = cats.map(c => {
        const pct = totalOut > 0 ? ((c.total / totalOut) * 100).toFixed(1) : 0;
        const filled = Math.round(pct / 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        return `*${c.category}*\n\`${bar}\` ${pct}%\n${c.count} tx · ${parseFloat(c.total).toFixed(2)} SEK`;
      }).join('\n\n');
      await bot.sendMessage(chatId,
        `*Spending by category (last 30 days)*\n\n${lines}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /week
  bot.onText(/\/week/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, 'Generating weekly summary...');
    try {
      const txs = await getTransactionsSince(sinceWeek());
      const summary = await generateSummary(txs, 'the last 7 days');
      await bot.sendMessage(chatId, `📅 *Weekly Summary*\n\n${summary}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /month
  bot.onText(/\/month/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, 'Generating monthly summary...');
    try {
      const txs = await getTransactionsSince(sinceMonth());
      const summary = await generateSummary(txs, 'the last 30 days');
      await bot.sendMessage(chatId, `📆 *Monthly Summary*\n\n${summary}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /search <keyword>
  bot.onText(/\/search (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const keyword = match[1].trim();
    try {
      const txs = await searchTransactions(keyword);
      if (txs.length === 0) {
        await bot.sendMessage(chatId, `No transactions found for "${keyword}".`);
        return;
      }
      const lines = txs.map(t => `${t.date}  ${formatTx(t)}`).join('\n\n');
      await bot.sendMessage(chatId, `*Search: "${keyword}"*\n\n${lines}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /merchants
  bot.onText(/\/merchants/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const merchants = await getAllMerchants();
      if (merchants.length === 0) {
        await bot.sendMessage(chatId, 'No merchants labeled yet.');
        return;
      }
      const lines = merchants.map(m =>
        `*${m.display_name}*${m.category ? ` — ${m.category}` : ''} (${m.tx_count}x)`
      ).join('\n');
      await bot.sendMessage(chatId, `*Known Merchants:*\n\n${lines}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /label <keyword> <name> [category]
  bot.onText(/\/label (\S+) (\S+)(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const [, keyword, name, category] = match;
    try {
      await upsertMerchant(keyword, name, category || '');
      await bot.sendMessage(chatId,
        `✅ Labeled *${keyword}* as *${name}*${category ? ` (${category})` : ''}.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /help
  bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
      `*Bank Accountant Commands*\n\n` +
      `*Upload*\nSend a *.csv* file exported from Nordea — the bot parses, deduplicates, and AI-analyzes every new transaction automatically.\n\n` +
      `*Review*\n` +
      `/today — Today's transactions\n` +
      `/recent — Last 10 transactions\n` +
      `/wasteful — Wasteful spending (last 30 days)\n` +
      `/questionable — Questionable spending (last 30 days)\n` +
      `/categories — Spending breakdown by category\n` +
      `/search <keyword> — Search by merchant, category, or description\n\n` +
      `*Reports*\n` +
      `/week — AI summary of last 7 days\n` +
      `/month — AI summary of last 30 days\n\n` +
      `*Merchants*\n` +
      `/merchants — List all labeled merchants\n` +
      `/label <keyword> <name> [category] — Label a merchant by keyword`,
      { parse_mode: 'Markdown' }
    );
  });

  console.log('Bank commands registered.');
}
