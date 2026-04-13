'use strict';

/**
 * MAX Bot API client
 *
 * Документация: https://dev.max.ru/docs
 * Base URL: https://botapi.max.ru
 * Auth: access_token в query-параметре
 *
 * Используется только для публикации в MAX канал.
 * Согласование с менеджером происходит через Telegram.
 */

const BASE_URL = 'https://botapi.max.ru';

function token() {
  const t = process.env.MAX_BOT_TOKEN;
  if (!t) throw new Error('MAX_BOT_TOKEN не задан');
  return t;
}

function channelId() {
  const id = process.env.MAX_CHANNEL_ID;
  if (!id) throw new Error('MAX_CHANNEL_ID не задан');
  return id;
}

/**
 * Выполняет HTTP-запрос к MAX Bot API.
 */
async function maxRequest(method, path, body = null) {
  const url = new URL(path, BASE_URL);
  url.searchParams.set('access_token', token());

  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url.toString(), opts);
  const json = await res.json();

  if (!res.ok) {
    const msg = json?.message || json?.description || JSON.stringify(json);
    throw new Error(`MAX API ${res.status}: ${msg}`);
  }

  return json;
}

/**
 * Публикует текстовое сообщение в MAX канал.
 * MAX Bot API: POST /messages?access_token=TOKEN&chat_id=CHAT_ID
 */
async function publishToChannel(text) {
  const chatId = channelId();
  return maxRequest('POST', '/messages', {
    chat_id: chatId,
    text,
  });
}

/**
 * Проверяет, что бот работает и токен валиден.
 * MAX Bot API: GET /me
 */
async function getMe() {
  return maxRequest('GET', '/me');
}

module.exports = { publishToChannel, getMe };
