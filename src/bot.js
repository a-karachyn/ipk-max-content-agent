'use strict';

/**
 * Модуль уведомлений менеджера.
 *
 * MAX-агент НЕ запускает Telegraf polling — это вызвало бы конфликт 409
 * с ipk-content-agent, который уже слушает тот же бот-токен.
 *
 * Здесь только ИСХОДЯЩИЕ запросы: sendMessage через HTTP POST.
 * Кнопки согласования (max_post_approve/edit/reject) обрабатывает
 * ipk-content-agent, который читает pending-пост из Redis max_content:
 * и публикует в MAX канал через MAX Bot API.
 */

const { setPendingPost, clearCaseDraft, setManagerState, getManagerState } = require('./redis');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const MANAGER_ID = parseInt(process.env.MANAGER_CHAT_ID, 10);

// ─── Raw HTTP helper ──────────────────────────────────────────────────────────

async function tgPost(method, body) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Telegram API ${method} error: ${json.description}`);
  }
  return json.result;
}

// ─── sendForApproval ─────────────────────────────────────────────────────────

async function sendForApproval(postText, postType) {
  await setPendingPost({ text: postText, type: postType });

  await tgPost('sendMessage', {
    chat_id: MANAGER_ID,
    text: `📝 <b>Новый пост для MAX канала (${postType === 'case' ? 'Кейс' : 'Новость/Совет'})</b>\n\n${postText}`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Опубликовать в MAX', callback_data: 'max_post_approve' },
          { text: '✏️ Редактировать',      callback_data: 'max_post_edit'    },
        ],
        [
          { text: '❌ Отклонить', callback_data: 'max_post_reject' },
        ],
      ],
    },
  });
}

// ─── startCaseCollection — просит менеджера ввести данные через /max_case ─────

async function startCaseCollection() {
  await clearCaseDraft();
  await tgPost('sendMessage', {
    chat_id: MANAGER_ID,
    text:
      `📋 <b>Запрос данных для MAX кейса</b>\n\n` +
      `Введите данные кейса командой /max_case в боте @ipk_content_bot\n` +
      `(задача → решение → результат)`,
    parse_mode: 'HTML',
  });
}

module.exports = { sendForApproval, startCaseCollection };
