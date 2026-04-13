'use strict';

const cron = require('node-cron');
const { getPostCount, incrementPostCount, getPendingPost, getCaseDraft } = require('./redis');
const { generateCasePost, generateNewsPost } = require('./agent');
const { sendForApproval, startCaseCollection } = require('./bot');

/**
 * Каждые 2 дня в 10:00 МСК генерируем пост для MAX канала.
 * Чётный счётчик → кейс (или новость, если данных нет).
 * Нечётный счётчик → новость/совет с web_search.
 */
function schedulePostGeneration() {
  // 10:00 МСК = 07:00 UTC
  cron.schedule(
    '0 7 */2 * *',
    async () => {
      console.log('[Scheduler] Запуск генерации поста для MAX...');

      const pending = await getPendingPost();
      if (pending) {
        console.log('[Scheduler] Пост уже ожидает согласования, генерация пропущена.');
        return;
      }

      const count = await getPostCount();
      const isCase = count % 2 === 0;
      await incrementPostCount();

      try {
        if (isCase) {
          const draft = await getCaseDraft();
          if (draft && draft.task && draft.solution && draft.result) {
            console.log('[Scheduler] Генерирую кейс из сохранённых данных...');
            const text = await generateCasePost(draft.task, draft.solution, draft.result);
            await sendForApproval(text, 'case');
          } else {
            console.log('[Scheduler] Данных для кейса нет, генерирую новостной пост...');
            const text = await generateNewsPost();
            await sendForApproval(text, 'news');
          }
        } else {
          console.log('[Scheduler] Генерирую новостной/советный пост...');
          const text = await generateNewsPost();
          await sendForApproval(text, 'news');
        }
      } catch (err) {
        console.error('[Scheduler] Ошибка генерации поста:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  console.log('[Scheduler] Генерация постов: каждые 2 дня в 10:00 МСК');
}

/**
 * Каждый понедельник в 9:00 МСК запрашиваем данные для кейса.
 */
function scheduleCaseRequest() {
  cron.schedule(
    '0 9 * * 1',
    async () => {
      console.log('[Scheduler] Запрос данных для кейса у менеджера...');
      try {
        await startCaseCollection();
      } catch (err) {
        console.error('[Scheduler] Ошибка запроса кейса:', err);
      }
    },
    { timezone: 'Europe/Moscow' },
  );

  console.log('[Scheduler] Запрос кейса: каждый понедельник в 9:00 МСК');
}

function startScheduler() {
  schedulePostGeneration();
  scheduleCaseRequest();
}

module.exports = { startScheduler };
