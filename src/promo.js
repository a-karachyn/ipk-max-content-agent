'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { SYSTEM_PROMPT } = require('./prompts');
const { redis } = require('./redis');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';

const GROUPS_KEY = 'max_content:promo:groups';
const PENDING_KEY = 'max_content:promo:pending_post';

// ─── Redis: база MAX сообществ ────────────────────────────────────────────────

async function getGroups() {
  const data = await redis.get(GROUPS_KEY);
  return data ? JSON.parse(data) : [];
}

async function saveGroups(groups) {
  await redis.set(GROUPS_KEY, JSON.stringify(groups));
}

async function mergeGroups(newGroups) {
  const existing = await getGroups();
  const existingLinks = new Set(existing.map((g) => g.link));
  const toAdd = newGroups.filter((g) => !existingLinks.has(g.link));
  const merged = [...existing, ...toAdd];
  await saveGroups(merged);
  return { added: toAdd.length, total: merged.length };
}

async function markGroupPublished(groupId, note) {
  const groups = await getGroups();
  const idx = groups.findIndex((g) => g.id === groupId);
  if (idx !== -1) {
    groups[idx].lastPublished = new Date().toISOString();
    groups[idx].publishNote = note;
  }
  await saveGroups(groups);
}

// ─── Redis: pending promo post ────────────────────────────────────────────────

async function getPromoPending() {
  const data = await redis.get(PENDING_KEY);
  return data ? JSON.parse(data) : null;
}

async function setPromoPending(data) {
  await redis.set(PENDING_KEY, JSON.stringify(data));
}

async function clearPromoPending() {
  await redis.del(PENDING_KEY);
}

// ─── Выбор следующей группы ───────────────────────────────────────────────────

function pickNextGroup(groups, excludeId = null) {
  const active = groups.filter((g) => g.status === 'active' && g.id !== excludeId);
  if (!active.length) return null;
  return active.sort((a, b) => {
    if (!a.lastPublished && !b.lastPublished) return 0;
    if (!a.lastPublished) return -1;
    if (!b.lastPublished) return 1;
    return new Date(a.lastPublished) - new Date(b.lastPublished);
  })[0];
}

// ─── Claude: поиск MAX сообществ ─────────────────────────────────────────────

async function searchGroups() {
  const prompt = `Найди актуальные сообщества, группы и чаты в мессенджере MAX (max.ru, бывший ICQ New) для профессиональной аудитории по темам:

1. Пожарная безопасность — проектирование СПС, СОУЭ, систем пожаротушения, монтаж, нормативы МЧС
2. СКУД, системы безопасности, интеграция охранных систем
3. Строительство и проектирование в Санкт-Петербурге и СЗФО
4. Экспертиза проектной документации — ГГЭ, негосударственная экспертиза, согласования
5. Инженерные системы зданий и сооружений

Если в MAX нет специализированных сообществ по этим темам, включи смежные:
— профессиональные инженерные сообщества
— строительные сообщества
— сообщества по охране труда и промышленной безопасности

Для каждого сообщества укажи название, ссылку (max.ru/...), тематику и краткое описание аудитории.

Верни ТОЛЬКО JSON-массив без пояснений:
[
  {"name": "...", "link": "max.ru/...", "topic": "...", "description": "..."},
  ...
]`;

  const messages = [{ role: 'user', content: prompt }];

  for (let i = 0; i < 8; i++) {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 4096,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages,
      },
      { headers: { 'anthropic-beta': 'web-search-2025-03-05' } },
    );

    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      const match = text.match(/\[[\s\S]*?\]/);
      if (!match) throw new Error('Модель не вернула JSON-массив с сообществами');

      const found = JSON.parse(match[0]);
      return found.map((g, idx) => ({
        id: `mg_${Date.now()}_${idx}`,
        name: g.name || 'Без названия',
        link: (g.link || '').trim(),
        topic: g.topic || '',
        description: g.description || '',
        status: 'active',
        lastPublished: null,
        publishNote: null,
      }));
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) break;

    messages.push({
      role: 'user',
      content: toolUses.map((tu) => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: [],
      })),
    });
  }

  throw new Error('Превышен лимит итераций при поиске сообществ');
}

// ─── Claude: генерация промо-поста для MAX ───────────────────────────────────

async function generatePromoPost(group) {
  const prompt = `Напиши пост для публикации в сообществе MAX от имени участника.

Сообщество: ${group.name}
Тематика: ${group.topic}
${group.description ? `Аудитория: ${group.description}` : ''}

Задача: полезный экспертный пост, который органично вписывается в это сообщество MAX.

Структура:
— 80% поста: конкретный полезный контент по теме "${group.topic}" (совет, нюанс нормативки, разбор типовой ситуации, факт из практики)
— Последние 2–3 строки: ненавязчивое упоминание канала ИПК в MAX (max.ru/id351000349259_biz) и бота как источника материалов и для подачи заявок

Требования:
— Стиль: коллега делится опытом, без рекламного тона
— Длина: 600–1000 символов
— Без HTML-тегов, только чистый текст с эмодзи
— Без хэштегов (выглядят как спам в чужих сообществах)
— Не начинать с названия компании`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

module.exports = {
  getGroups,
  saveGroups,
  mergeGroups,
  markGroupPublished,
  getPromoPending,
  setPromoPending,
  clearPromoPending,
  pickNextGroup,
  searchGroups,
  generatePromoPost,
};
