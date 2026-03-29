import 'dotenv/config';
import { initDb } from './db.js';
import { setupCommands } from './commands.js';
import { bot } from './bot.js';

async function start() {
  console.log('Initializing database...');
  await initDb();
  console.log('Database ready.');

  setupCommands();

  bot.on('polling_error', (err) => {
    console.error('Telegram polling error:', err.message);
  });

  console.log('Bank Accountant Agent is running.');
}

start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
