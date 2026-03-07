import TelegramBot from 'node-telegram-bot-api';

const TELEGRAM_ENABLED =
  process.env.TELEGRAM_BOT_TOKEN &&
  process.env.TELEGRAM_BOT_TOKEN !== 'your_telegram_bot_token';

let bot;
if (TELEGRAM_ENABLED) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
}

export { bot, TELEGRAM_ENABLED };
