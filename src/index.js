'use strict';

require('dotenv').config();

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
    // Не падаем — планировщик продолжит работу, публикация будет ошибочной
  }

  // Запускаем планировщик (генерация постов + уведомления через HTTP)
  // Telegram polling НЕ запускается — его ведёт ipk-content-agent.
  // Кнопки согласования обрабатывает ipk-content-agent.
  startScheduler();

  console.log('[App] MAX Content Agent запущен (scheduler only, no Telegram polling)');

  process.once('SIGINT',  () => { console.log('[App] SIGINT');  redis.quit(); });
  process.once('SIGTERM', () => { console.log('[App] SIGTERM'); redis.quit(); });
}

main().catch((err) => {
  console.error('[App] Критическая ошибка запуска:', err);
  process.exit(1);
});
