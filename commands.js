import { bot } from './bot.js';
import {
  getRecentTransactions, getTransactionsSince, getBiggestTransactions,
  searchTransactions, getSpendingByCategory, getSetting, setSetting,
  addWatchedWallet, removeWatchedWallet, getWatchedWallets,
  upsertMerchant, getAllMerchants, removeMerchant, promoteMerchant, getMerchant,
  getTransactionByHash, updateTransactionAnalysis, getTransactionsByCategory,
} from './db.js';

async function resolveCounterparty(tx) {
  const address = tx.direction === 'out' ? tx.to_address : tx.from_address;
  if (!address) return 'Unknown';
  const merchant = await getMerchant(address);
  return merchant ? merchant.name : address;
}

async function formatTxDetail(tx) {
  const counterparty = await resolveCounterparty(tx);
  const counterpartyAddress = tx.direction === 'out' ? tx.to_address : tx.from_address;
  const merchant = await getMerchant(counterpartyAddress);
  const dir = tx.direction === 'in' ? '⬇️ Received' : '⬆️ Sent';
  const date = new Date(tx.timestamp * 1000).toLocaleString();
  const merchantCategory = merchant?.category ? `*Merchant Category:* ${merchant.category}\n` : '';

  return (
    `${dir} *${tx.value_eth} ${tx.asset}*\n\n` +
    `*${tx.direction === 'out' ? 'To' : 'From'}:* ${counterparty}\n` +
    `*Address:* \`${counterpartyAddress}\`\n` +
    `*Type:* ${tx.category}\n` +
    `${merchantCategory}` +
    `*Summary:* ${tx.summary || 'N/A'}\n` +
    `*Date:* ${date}\n` +
    `*Hash:* \`${tx.hash}\``
  );
}

// In-memory state for multi-step conversations
// { chatId: { action: 'merchant'|'one_off', address: '0x...' } }
const pendingStates = new Map();
import { generateDailySummary, categorizeTransaction } from './analyzer.js';
import { alchemy, WALLET } from './monitor.js';
import { formatEther } from 'ethers';

const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function getBalances(address) {
  const [ethBalanceHex, tokenBalances] = await Promise.all([
    alchemy.core.getBalance(address),
    alchemy.core.getTokenBalances(address, [USDC_CONTRACT]),
  ]);
  const ethBalance = parseFloat(formatEther(ethBalanceHex)).toFixed(6);
  const usdcRaw = tokenBalances.tokenBalances[0]?.tokenBalance || '0';
  const usdcBalance = (parseInt(usdcRaw, 16) / 1e6).toFixed(2);
  return { ethBalance, usdcBalance };
}

export function setupCommands() {
  // /balance
  bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const { ethBalance, usdcBalance } = await getBalances(WALLET);
      const watched = await getWatchedWallets();
      let text = `*Your Wallet Balance*\n\nETH: \`${ethBalance}\`\nUSDC: \`$${usdcBalance}\``;
      for (const w of watched) {
        const b = await getBalances(w.address);
        const label = w.label || w.address.slice(0, 8) + '...';
        text += `\n\n*${label}*\nETH: \`${b.ethBalance}\`\nUSDC: \`$${b.usdcBalance}\``;
      }
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /today
  bot.onText(/\/today/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const startOfDay = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
      const txs = await getTransactionsSince(startOfDay);
      if (txs.length === 0) {
        await bot.sendMessage(chatId, 'No transactions today.');
        return;
      }
      const lines = txs.map(tx => {
        const time = new Date(tx.timestamp * 1000).toLocaleTimeString();
        const dir = tx.direction === 'in' ? '⬇️' : '⬆️';
        return `${dir} *${tx.value_eth} ${tx.asset}* — ${tx.category} _${time}_`;
      }).join('\n');
      await bot.sendMessage(chatId, `*Today's transactions:*\n\n${lines}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /week
  bot.onText(/\/week/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, 'Generating weekly summary...');
    try {
      const since = Math.floor(Date.now() / 1000) - 7 * 86400;
      const txs = await getTransactionsSince(since);
      if (txs.length === 0) {
        await bot.sendMessage(chatId, 'No transactions in the last 7 days.');
        return;
      }
      const summary = await generateDailySummary(txs, WALLET);
      await bot.sendMessage(chatId, `📅 *Weekly Summary*\n\n${summary}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /biggest
  bot.onText(/\/biggest/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const txs = await getBiggestTransactions(5);
      if (txs.length === 0) {
        await bot.sendMessage(chatId, 'No transactions found.');
        return;
      }
      const lines = txs.map((tx, i) => {
        const date = new Date(tx.timestamp * 1000).toLocaleDateString();
        const dir = tx.direction === 'in' ? '⬇️' : '⬆️';
        return `${i + 1}. ${dir} *${tx.value_eth} ${tx.asset}* — ${tx.category}\n_${date}_`;
      }).join('\n\n');
      await bot.sendMessage(chatId, `*Top 5 Biggest Transactions:*\n\n${lines}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /in
  bot.onText(/\/in$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const since = Math.floor(Date.now() / 1000) - 86400;
      const txs = (await getTransactionsSince(since)).filter(t => t.direction === 'in');
      if (txs.length === 0) {
        await bot.sendMessage(chatId, 'No incoming transactions in the last 24h.');
        return;
      }
      const lines = txs.map(tx => {
        const time = new Date(tx.timestamp * 1000).toLocaleTimeString();
        return `⬇️ *${tx.value_eth} ${tx.asset}* — ${tx.summary || tx.category} _${time}_`;
      }).join('\n');
      await bot.sendMessage(chatId, `*Incoming (last 24h):*\n\n${lines}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /out
  bot.onText(/\/out$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const since = Math.floor(Date.now() / 1000) - 86400;
      const txs = (await getTransactionsSince(since)).filter(t => t.direction === 'out');
      if (txs.length === 0) {
        await bot.sendMessage(chatId, 'No outgoing transactions in the last 24h.');
        return;
      }
      const lines = txs.map(tx => {
        const time = new Date(tx.timestamp * 1000).toLocaleTimeString();
        return `⬆️ *${tx.value_eth} ${tx.asset}* — ${tx.summary || tx.category} _${time}_`;
      }).join('\n');
      await bot.sendMessage(chatId, `*Outgoing (last 24h):*\n\n${lines}`, { parse_mode: 'Markdown' });
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
      const lines = txs.slice(0, 10).map(tx => {
        const date = new Date(tx.timestamp * 1000).toLocaleDateString();
        const dir = tx.direction === 'in' ? '⬇️' : '⬆️';
        return `${dir} *${tx.value_eth} ${tx.asset}* — ${tx.category} _${date}_`;
      }).join('\n');
      await bot.sendMessage(chatId, `*Search: "${keyword}"*\n\n${lines}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /fees
  bot.onText(/\/fees/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const txs = (await getRecentTransactions(1000)).filter(t => t.asset === 'ETH' && t.direction === 'out');
      const total = txs.reduce((sum, t) => sum + t.value_eth, 0);
      await bot.sendMessage(chatId,
        `*Gas Fees Paid*\n\nTotal ETH spent on gas: \`${total.toFixed(6)} ETH\`\nAcross ${txs.length} transactions`,
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
      const all = await getRecentTransactions(1000);
      if (all.length === 0) {
        await bot.sendMessage(chatId, 'No transactions found.');
        return;
      }
      const out = all.filter(t => t.direction === 'out');
      const inc = all.filter(t => t.direction === 'in');

      const grouped = {};
      for (const tx of out) {
        const merchant = await getMerchant(tx.to_address);
        const cat = (merchant?.category) || tx.category || 'Other';
        if (!grouped[cat]) grouped[cat] = { count: 0, total: 0 };
        grouped[cat].count++;
        grouped[cat].total += tx.value_eth;
      }

      const totalOut = out.reduce((s, t) => s + t.value_eth, 0);
      const totalIn = inc.reduce((s, t) => s + t.value_eth, 0);

      const sorted = Object.entries(grouped).sort((a, b) => b[1].total - a[1].total);
      const bars = sorted.map(([cat, { total, count }]) => {
        const pct = totalOut > 0 ? ((total / totalOut) * 100).toFixed(1) : 0;
        const filled = Math.round(pct / 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        return `*${cat}*\n\`${bar}\` ${pct}%\n${count} tx · ${total.toFixed(4)} assets`;
      }).join('\n\n');

      await bot.sendMessage(chatId,
        `*Spending Breakdown*\n\n${bars}\n\n` +
        `Total in: \`${totalIn.toFixed(4)}\`\n` +
        `Total out: \`${totalOut.toFixed(4)}\`\n` +
        `Transactions: ${all.length}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /catdetails <category>
  bot.onText(/\/catdetails (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const category = match[1].trim();
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    try {
      const txs = await getTransactionsByCategory(category, since);
      if (txs.length === 0) {
        await bot.sendMessage(chatId, `No transactions found in *${category}* for the last 30 days.`, { parse_mode: 'Markdown' });
        return;
      }
      const total = txs.reduce((s, t) => s + t.value_eth, 0);
      const lines = txs.map(tx => {
        const date = new Date(tx.timestamp * 1000).toLocaleDateString();
        const name = tx.merchant_name || tx.to_address.slice(0, 10) + '...';
        return `• *${name}* — ${tx.value_eth} ${tx.asset} — _${date}_`;
      }).join('\n');
      await bot.sendMessage(chatId,
        `*${category}* — last 30 days\n\n${lines}\n\n*Total: ${total.toFixed(4)}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /topspend
  bot.onText(/\/topspend/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const categories = await getSpendingByCategory();
      if (categories.length === 0) {
        await bot.sendMessage(chatId, 'No spending data yet.');
        return;
      }
      const lines = categories.map((c, i) =>
        `${i + 1}. *${c.category}* — ${parseFloat(c.total).toFixed(4)} (${c.count} txs)`
      ).join('\n');
      await bot.sendMessage(chatId, `*Top Spending Categories:*\n\n${lines}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /watch <address> [label]
  bot.onText(/\/watch (0x[a-fA-F0-9]{40})(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const address = match[1];
    const label = match[2] || '';
    try {
      await addWatchedWallet(address, label);
      await bot.sendMessage(chatId,
        `Watching \`${address}\`${label ? ` as *${label}*` : ''}.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /unwatch <address>
  bot.onText(/\/unwatch (0x[a-fA-F0-9]{40})/, async (msg, match) => {
    const chatId = msg.chat.id;
    await removeWatchedWallet(match[1]);
    await bot.sendMessage(chatId, `Stopped watching \`${match[1]}\`.`, { parse_mode: 'Markdown' });
  });

  // /alert <amount>
  bot.onText(/\/alert (\d+\.?\d*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const threshold = parseFloat(match[1]);
    await setSetting('alert_threshold', threshold);
    await bot.sendMessage(chatId,
      threshold === 0
        ? 'Alert threshold removed. You will be notified of all transactions.'
        : `Alert threshold set to *$${threshold}*. You will only be notified for transactions above this amount.`,
      { parse_mode: 'Markdown' }
    );
  });

  // /merchant <address> <name> [category]
  bot.onText(/\/merchant (0x[a-fA-F0-9]{40}) ([^\s]+)(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const address = match[1];
    const name = match[2];
    const category = match[3] || '';
    try {
      await upsertMerchant(address, name, category);
      await bot.sendMessage(chatId,
        `Labeled \`${address}\` as *${name}*${category ? ` (${category})` : ''}.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /merchants
  bot.onText(/\/merchants$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const merchants = await getAllMerchants();
      if (merchants.length === 0) {
        await bot.sendMessage(chatId, 'No merchants labeled yet. Use /merchant <address> <name> to add one.');
        return;
      }
      const lines = merchants.map(m =>
        `*${m.name}*${m.category ? ` (${m.category})` : ''}\n\`${m.address}\``
      ).join('\n\n');
      await bot.sendMessage(chatId, `*Known Merchants:*\n\n${lines}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /unmerchant <address>
  bot.onText(/\/unmerchant (0x[a-fA-F0-9]{40})/, async (msg, match) => {
    const chatId = msg.chat.id;
    await removeMerchant(match[1]);
    await bot.sendMessage(chatId, `Removed label for \`${match[1]}\`.`, { parse_mode: 'Markdown' });
  });

  // /pause
  bot.onText(/\/pause/, async (msg) => {
    await setSetting('paused', 'true');
    await bot.sendMessage(msg.chat.id,
      'Alerts paused. The agent is still running and logging. Use /resume to re-enable alerts.'
    );
  });

  // /resume
  bot.onText(/\/resume/, async (msg) => {
    await setSetting('paused', 'false');
    await bot.sendMessage(msg.chat.id, 'Alerts resumed.');
  });

  // /summary
  bot.onText(/\/summary/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, 'Generating summary...');
    try {
      const since = Math.floor(Date.now() / 1000) - 86400;
      const txs = await getTransactionsSince(since);
      if (txs.length === 0) {
        await bot.sendMessage(chatId, 'No transactions in the last 24 hours.');
        return;
      }
      const summary = await generateDailySummary(txs, WALLET);
      await bot.sendMessage(chatId, `📊 *Summary (last 24h)*\n\n${summary}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /recent — simple list
  bot.onText(/\/recent$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const txs = await getRecentTransactions(5);
      if (txs.length === 0) {
        await bot.sendMessage(chatId, 'No transactions found.');
        return;
      }
      const lines = await Promise.all(txs.map(async tx => {
        const date = new Date(tx.timestamp * 1000).toLocaleString();
        const dir = tx.direction === 'in' ? '⬇️' : '⬆️';
        const counterparty = await resolveCounterparty(tx);
        return `${dir} *${tx.value_eth} ${tx.asset}* → *${counterparty}*\n_${date}_`;
      }));
      await bot.sendMessage(chatId, `*Last 5 transactions:*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /details — full info for last 5
  bot.onText(/\/details/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      const txs = await getRecentTransactions(5);
      if (txs.length === 0) {
        await bot.sendMessage(chatId, 'No transactions found.');
        return;
      }
      for (const tx of txs) {
        await bot.sendMessage(chatId, await formatTxDetail(tx), { parse_mode: 'Markdown' });
      }
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /reanalyze <number|hash>
  bot.onText(/\/reanalyze (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].trim();
    const isNumber = /^\d+$/.test(input);

    try {
      let txs = [];

      if (isNumber) {
        const count = Math.min(parseInt(input), 50); // cap at 50
        txs = await getRecentTransactions(count);
        await bot.sendMessage(chatId, `Re-analyzing last ${txs.length} transactions with Kimi...`);
      } else {
        const tx = await getTransactionByHash(input.toLowerCase());
        if (!tx) {
          await bot.sendMessage(chatId, `No transaction found matching \`${input}\`.`, { parse_mode: 'Markdown' });
          return;
        }
        txs = [tx];
        await bot.sendMessage(chatId, `Re-analyzing transaction \`${input}\`...`, { parse_mode: 'Markdown' });
      }

      let updated = 0;
      for (const tx of txs) {
        try {
          const merchant = await getMerchant(tx.direction === 'out' ? tx.to_address : tx.from_address);
          const analysis = await categorizeTransaction({ ...tx, merchantName: merchant?.name || null });
          await updateTransactionAnalysis(tx.hash, analysis.category, analysis.summary);
          updated++;
        } catch {
          // skip failed ones silently
        }
      }

      await bot.sendMessage(chatId, `Done. Updated ${updated}/${txs.length} transactions.`);
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /tx <hash> — lookup a specific transaction
  bot.onText(/\/tx (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].trim().toLowerCase();
    try {
      const tx = await getTransactionByHash(input);
      if (!tx) {
        await bot.sendMessage(chatId, `No transaction found matching \`${input}\`.\n\nTip: Use /details to see recent hashes.`, { parse_mode: 'Markdown' });
        return;
      }
      await bot.sendMessage(chatId, `*Transaction Details*\n\n${await formatTxDetail(tx)}`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  });

  // /help
  bot.onText(/\/help/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
      `*Wallet Accountant Commands*\n\n` +
      `*Balances & History*\n` +
      `/balance — Current ETH + USDC balance\n` +
      `/today — Today's transactions\n` +
      `/recent — Last 5 transactions with merchant names\n` +
      `/details — Full info for last 5 transactions\n` +
      `/tx <hash> — Full details of a specific transaction\n` +
      `/reanalyze <number> — Re-run AI on last N transactions\n` +
      `/reanalyze <hash> — Re-run AI on a specific transaction\n` +
      `/biggest — Top 5 largest transactions\n` +
      `/in — Incoming transactions (24h)\n` +
      `/out — Outgoing transactions (24h)\n` +
      `/search <keyword> — Search transactions\n\n` +
      `*Reports*\n` +
      `/summary — AI summary of last 24h\n` +
      `/week — AI weekly summary\n` +
      `/fees — Total gas fees paid\n` +
      `/categories — Visual spending breakdown\n` +
      `/catdetails <category> — All transactions in a category (last 30 days)\n` +
      `/topspend — Spending by category\n\n` +
      `*Settings*\n` +
      `/merchant <address> <name> [category] — Label an address as a merchant\n` +
      `/merchants — List all known merchants\n` +
      `/unmerchant <address> — Remove a merchant label\n` +
      `/watch <address> [label] — Monitor another wallet\n` +
      `/unwatch <address> — Stop watching a wallet\n` +
      `/alert <amount> — Only alert for txs above amount (0 = all)\n` +
      `/pause — Silence alerts\n` +
      `/resume — Re-enable alerts`,
      { parse_mode: 'Markdown' }
    );
  });

  // Handle inline button presses
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    await bot.answerCallbackQuery(query.id);

    if (data.startsWith('label_merchant:')) {
      const address = data.split(':')[1];
      pendingStates.set(chatId, { action: 'merchant', address });
      await bot.sendMessage(chatId, '🏪 What should I call this merchant?');

    } else if (data.startsWith('label_transfer:')) {
      const address = data.split(':')[1];
      pendingStates.set(chatId, { action: 'transfer', address });
      await bot.sendMessage(chatId, '👤 Who is this? (e.g. "Friend John", "Cold Wallet", "Agent Wallet")');

    } else if (data.startsWith('label_oneoff:')) {
      const address = data.split(':')[1];
      pendingStates.set(chatId, { action: 'one_off', address });
      await bot.sendMessage(chatId, '🔖 What was this one-off payment for?');

    } else if (data.startsWith('promote:')) {
      const address = data.split(':')[1];
      await promoteMerchant(address);
      await bot.sendMessage(chatId, '✅ Saved as a permanent merchant!');

    } else if (data.startsWith('keep_oneoff:')) {
      await bot.sendMessage(chatId, '🔖 Kept as one-off.');

    } else if (data.startsWith('skip:')) {
      await bot.sendMessage(chatId, '⏭ Skipped.');
    }
  });

  // Handle text replies for naming merchants/one-offs
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const state = pendingStates.get(chatId);
    if (!state || !msg.text || msg.text.startsWith('/')) return;

    pendingStates.delete(chatId);
    const { action, address } = state;
    const name = msg.text.trim();

    if (action === 'merchant') {
      await upsertMerchant(address, name, '', 'merchant');
      await bot.sendMessage(chatId,
        `✅ *${name}* saved as a merchant. Future payments to this address will be labeled automatically.`,
        { parse_mode: 'Markdown' }
      );
    } else if (action === 'transfer') {
      await upsertMerchant(address, name, 'Transfer', 'transfer');
      await bot.sendMessage(chatId,
        `👤 Saved as *${name}*. Future transfers to this address will be labeled automatically.`,
        { parse_mode: 'Markdown' }
      );
    } else if (action === 'one_off') {
      await upsertMerchant(address, name, '', 'one_off');
      await bot.sendMessage(chatId,
        `🔖 Payment labeled as *${name}*. If you pay this address again I'll ask if you want to save it as a merchant.`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  console.log('Telegram commands registered.');
}
