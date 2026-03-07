import { bot, TELEGRAM_ENABLED } from './bot.js';

const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendAlert(message) {
  console.log(`\n[ALERT] ${message}`);
  if (TELEGRAM_ENABLED) {
    try {
      await bot.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Telegram send failed:', err.message);
    }
  }
}

export async function sendDailySummary(summary) {
  const message = `📊 *Daily Wallet Report*\n\n${summary}`;
  console.log(`\n${message}`);
  if (TELEGRAM_ENABLED) {
    try {
      await bot.sendMessage(CHAT_ID, message, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Telegram send failed:', err.message);
    }
  }
}

export async function sendMerchantPrompt(address, value, asset, txHash, existing = null, addressType = 'eoa') {
  if (!TELEGRAM_ENABLED) return;

  try {
    const shortAddr = `${address.slice(0, 8)}...${address.slice(-4)}`;

    // Re-prompt for known one-off addresses
    if (existing) {
      await bot.sendMessage(CHAT_ID,
        `You've paid *${existing.name}* before (${existing.tx_count} times). Save as a permanent merchant?`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Yes, save as merchant', callback_data: `promote:${address}` },
              { text: '🔖 Keep as one-off', callback_data: `keep_oneoff:${address}` },
            ]],
          },
        }
      );
      return;
    }

    const typeHint = addressType === 'contract' ? 'smart contract' : 'wallet';
    await bot.sendMessage(CHAT_ID,
      `📍 New payment of *${value} ${asset}* to \`${shortAddr}\` (${typeHint})\nWhat was this payment for?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🏪 Merchant', callback_data: `label_merchant:${address}` },
            { text: '👤 Transfer', callback_data: `label_transfer:${address}` },
            { text: '🔖 One-off', callback_data: `label_oneoff:${address}` },
            { text: '⏭ Skip', callback_data: `skip:${address}` },
          ]],
        },
      }
    );
  } catch (err) {
    console.error('Merchant prompt failed:', err.message);
  }
}
