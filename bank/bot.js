import TelegramBot from 'node-telegram-bot-api';

if (!process.env.BANK_TELEGRAM_BOT_TOKEN) {
  throw new Error('BANK_TELEGRAM_BOT_TOKEN is not set');
}

export const bot = new TelegramBot(process.env.BANK_TELEGRAM_BOT_TOKEN, { polling: true });
