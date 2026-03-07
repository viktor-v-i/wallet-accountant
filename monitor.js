import 'dotenv/config';
import { Alchemy, Network, AssetTransfersCategory } from 'alchemy-sdk';
import { initDb, insertTransaction, isKnownTransaction, getTransactionsSince, getWatchedWallets, getSetting, getMerchant, upsertMerchant, incrementMerchantCount } from './db.js';
import { categorizeTransaction, generateDailySummary } from './analyzer.js';
import { sendAlert, sendDailySummary, sendMerchantPrompt } from './notify.js';
import { TELEGRAM_ENABLED } from './bot.js';
import { setupCommands } from './commands.js';

export const WALLET = process.env.WALLET_ADDRESS;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS) || 30000;

export const alchemy = new Alchemy({
  apiKey: process.env.ALCHEMY_API_KEY,
  network: Network.BASE_MAINNET,
});

let lastDailySummaryDate = '';

async function fetchNewTransactions(address) {
  const [incoming, outgoing] = await Promise.all([
    alchemy.core.getAssetTransfers({
      toAddress: address,
      category: [
        AssetTransfersCategory.EXTERNAL,
        AssetTransfersCategory.ERC20,
        AssetTransfersCategory.ERC721,
        AssetTransfersCategory.ERC1155,
      ],
      withMetadata: true,
      maxCount: 20,
    }),
    alchemy.core.getAssetTransfers({
      fromAddress: address,
      category: [
        AssetTransfersCategory.EXTERNAL,
        AssetTransfersCategory.ERC20,
        AssetTransfersCategory.ERC721,
        AssetTransfersCategory.ERC1155,
      ],
      withMetadata: true,
      maxCount: 20,
    }),
  ]);

  const all = [
    ...incoming.transfers.map(t => ({ ...t, direction: 'in' })),
    ...outgoing.transfers.map(t => ({ ...t, direction: 'out' })),
  ];

  const results = await Promise.all(all.map(async tx => ({
    tx,
    known: await isKnownTransaction(tx.hash),
  })));

  return results.filter(r => !r.known).map(r => r.tx);
}

async function getOwnWallets() {
  const watched = await getWatchedWallets();
  const set = new Set([WALLET.toLowerCase()]);
  watched.forEach(w => set.add(w.address.toLowerCase()));
  return set;
}

async function getAddressType(address) {
  try {
    const code = await alchemy.core.getCode(address);
    return code && code !== '0x' ? 'contract' : 'eoa';
  } catch {
    return 'eoa';
  }
}

async function lookupMerchant(address, ownWallets) {
  // 1. Own wallet — auto internal transfer
  if (ownWallets.has(address.toLowerCase())) {
    return { name: 'Internal Transfer', type: 'internal', category: 'Transfer' };
  }

  // 2. Check local DB
  const local = await getMerchant(address);
  if (local) return local;

  // 3. Try Basescan to auto-resolve contract names
  try {
    const res = await fetch(`https://api.basescan.org/api?module=contract&action=getsourcecode&address=${address}&apikey=YourApiKeyToken`);
    const data = await res.json();
    if (data.status === '1' && data.result?.[0]?.ContractName) {
      const name = data.result[0].ContractName;
      await upsertMerchant(address, name, 'Contract', 'merchant');
      return { name, category: 'Contract', type: 'merchant' };
    }
  } catch {
    // Basescan lookup failed silently
  }

  return null;
}

async function processTransaction(tx, walletLabel = '') {
  const valueEth = tx.value || 0;
  const asset = tx.asset || 'ETH';
  const timestamp = tx.metadata?.blockTimestamp
    ? Math.floor(new Date(tx.metadata.blockTimestamp).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const partial = {
    hash: tx.hash,
    block_number: parseInt(tx.blockNum, 16) || 0,
    timestamp,
    from_address: tx.from,
    to_address: tx.to,
    value_eth: valueEth,
    value_usd: 0,
    asset,
    category: tx.category,
    direction: tx.direction,
    summary: '',
    raw: JSON.stringify(tx),
  };

  // Resolve merchant name for the counterparty address
  const counterparty = tx.direction === 'out' ? tx.to : tx.from;
  const ownWallets = await getOwnWallets();
  const merchant = await lookupMerchant(counterparty, ownWallets);
  const merchantName = merchant ? merchant.name : null;

  console.log(`\nNew ${tx.direction.toUpperCase()} tx: ${valueEth} ${asset} | ${merchantName || counterparty} | ${tx.hash}`);

  let analysis = { category: tx.category, summary: '' };
  try {
    analysis = await categorizeTransaction({ ...partial, merchantName });
  } catch (err) {
    console.error('Analysis failed:', err.message);
  }

  await insertTransaction({ ...partial, ...analysis });

  const paused = await getSetting('paused', 'false') === 'true';
  const threshold = parseFloat(await getSetting('alert_threshold', '0'));
  if (!paused && valueEth >= threshold) {
    const direction = tx.direction === 'in' ? 'Received' : 'Sent';
    const walletInfo = walletLabel ? ` _(${walletLabel})_` : '';
    const merchantInfo = merchantName ? ` → *${merchantName}*` : ` → \`${counterparty.slice(0, 10)}...\``;
    const alert = `*${direction}* ${valueEth} ${asset}${merchantInfo}${walletInfo}\n${analysis.summary}\n\`${tx.hash.slice(0, 12)}...\``;
    await sendAlert(alert);

    // Smart prompt for outgoing transactions to unknown/one-off addresses
    if (tx.direction === 'out') {
      const existing = await getMerchant(counterparty);
      if (!existing) {
        // Detect contract vs regular wallet to show right buttons
        const addressType = ownWallets.has(counterparty.toLowerCase())
          ? 'internal'
          : await getAddressType(counterparty);
        if (addressType !== 'internal') {
          await sendMerchantPrompt(counterparty, valueEth, asset, tx.hash, null, addressType);
        }
      } else if (existing.type === 'one_off') {
        await incrementMerchantCount(counterparty);
        await sendMerchantPrompt(counterparty, valueEth, asset, tx.hash, existing, 'eoa');
      }
    }
  }
}

async function checkDailySummary() {
  const today = new Date().toISOString().split('T')[0];
  const hour = new Date().getHours();
  if (hour >= 20 && lastDailySummaryDate !== today) {
    lastDailySummaryDate = today;
    const startOfDay = Math.floor(new Date(today).getTime() / 1000);
    const txs = await getTransactionsSince(startOfDay);
    const summary = await generateDailySummary(txs, WALLET);
    await sendDailySummary(summary);
  }
}

async function poll() {
  try {
    const walletsToWatch = [
      { address: WALLET, label: '' },
      ...( await getWatchedWallets()).map(w => ({ address: w.address, label: w.label || w.address.slice(0, 8) })),
    ];

    let totalNew = 0;
    for (const { address, label } of walletsToWatch) {
      const newTxs = await fetchNewTransactions(address);
      totalNew += newTxs.length;
      for (const tx of newTxs) {
        await processTransaction(tx, label);
      }
    }

    if (totalNew === 0) process.stdout.write('.');
    else console.log(`\nProcessed ${totalNew} new transaction(s)`);

    await checkDailySummary();
  } catch (err) {
    console.error('\nPoll error:', err.message);
  }
}

async function start() {
  console.log(`Wallet Accountant Agent started`);
  console.log(`Watching: ${WALLET}`);
  console.log(`Network:  Base Mainnet`);
  console.log(`Model:    ${process.env.MODEL}`);
  console.log(`Polling every ${POLL_INTERVAL / 1000}s\n`);

  await initDb();
  console.log('Database ready.');

  if (TELEGRAM_ENABLED) setupCommands();
  await poll();
  setInterval(poll, POLL_INTERVAL);
}

start().catch(console.error);
