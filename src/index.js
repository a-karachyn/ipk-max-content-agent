'use strict';

require('dotenv').config();

const { bot } = require('./bot');
const { startScheduler } = require('./scheduler');
const { redis } = require('./redis');
const { getMe } = require('./max');

async function main() {
  // Проверяем Redis
  await redis.ping();
  console.log('[App] Redis OK');

  // Проверяем MAX Bot API
  try {
    const me = await getMe();
    console.log(`[App] MAX Bot OK: @${me.username || me.name || me.user_id}`);
  } catch (err) {
    console.error('[App] MAX Bot API недоступен:', err.message);
    console.error('[App] Публикация в MAX будет недоступна до исправления токена/сети.');
    // Не падаем — Telegram-бот и генерация постов продолжат работать
  }

  // Запускаем планировщик
  startScheduler();

  // Запускаем Telegram бота (для уведомлений менеджеру)
  bot.launch({
    allowedUpdates: ['message', 'callback_query'],
  });

  console.log('[App] Telegram бот запущен');
  console.log('[App] MAX Content Agent готов к работе');

  // Graceful shutdown
  process.once('SIGINT', () => {
    console.log('[App] SIGINT — завершение...');
    bot.stop('SIGINT');
    redis.quit();
  });
  process.once('SIGTERM', () => {
    console.log('[App] SIGTERM — завершение...');
    bot.stop('SIGTERM');
    redis.quit();
  });
}

main().catch((err) => {
  console.error('[App] Критическая ошибка запуска:', err);
  process.exit(1);
});
