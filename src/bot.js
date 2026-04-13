'use strict';

const { Telegraf, Markup } = require('telegraf');
const {
  getPendingPost,
  setPendingPost,
  clearPendingPost,
  getManagerState,
  setManagerState,
  setCaseField,
  getCaseDraft,
  clearCaseDraft,
} = require('./redis');
const { generateCasePost, generateNewsPost } = require('./agent');
const { publishToChannel } = require('./max');
const {
  getGroups,
  mergeGroups,
  markGroupPublished,
  getPromoPending,
  setPromoPending,
  clearPromoPending,
  pickNextGroup,
  searchGroups,
  generatePromoPost,
} = require('./promo');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const MANAGER_ID = parseInt(process.env.MANAGER_CHAT_ID, 10);

// ─── Keyboards ────────────────────────────────────────────────────────────────

function approvalKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Опубликовать в MAX', 'max_post_approve'),
      Markup.button.callback('✏️ Редактировать', 'max_post_edit'),
    ],
    [Markup.button.callback('❌ Отклонить', 'max_post_reject')],
  ]);
}

function promoApprovalKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Готово к публикации', 'max_promo_approve')],
    [
      Markup.button.callback('✏️ Редактировать', 'max_promo_edit'),
      Markup.button.callback('⏭️ Следующая группа', 'max_promo_next'),
    ],
  ]);
}

// ─── Отправка поста на согласование ──────────────────────────────────────────

async function sendForApproval(postText, postType) {
  await setPendingPost({ text: postText, type: postType });

  await bot.telegram.sendMessage(
    MANAGER_ID,
    `📝 <b>Новый пост для MAX канала (${postType === 'case' ? 'Кейс' : 'Новость/Совет'})</b>\n\n${postText}`,
    {
      parse_mode: 'HTML',
      ...approvalKeyboard(),
    },
  );
}

// ─── Callbacks: согласование поста ───────────────────────────────────────────

bot.action('max_post_approve', async (ctx) => {
  await ctx.answerCbQuery();

  const post = await getPendingPost();
  if (!post) return ctx.reply('Нет поста в очереди.');

  try {
    await publishToChannel(post.text);
    await clearPendingPost();
    await setManagerState('idle');
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply('✅ Пост опубликован в MAX канал!');
  } catch (err) {
    console.error('[Bot] MAX publish error:', err);
    await ctx.reply(`Ошибка публикации в MAX: ${err.message}`);
  }
});

bot.action('max_post_edit', async (ctx) => {
  await ctx.answerCbQuery();
  await setManagerState('editing');
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply('✏️ Отправьте отредактированный текст поста.\n\n/max_cancel — отменить.');
});

bot.action('max_post_reject', async (ctx) => {
  await ctx.answerCbQuery();
  await clearPendingPost();
  await setManagerState('idle');
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply('❌ Пост отклонён.');
});

// ─── Команды ──────────────────────────────────────────────────────────────────

bot.command('max_help', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  await ctx.replyWithHTML(
    `<b>Команды IPK MAX Content Agent</b>\n\n` +
    `<b>Контент (MAX канал):</b>\n` +
    `/max_generate — сгенерировать пост для MAX канала\n` +
    `/max_case — запустить сбор данных для кейса\n` +
    `/max_status — состояние агента и очередь постов\n\n` +
    `<b>Продвижение в MAX:</b>\n` +
    `/max_promo — найти профильные сообщества MAX через AI\n` +
    `/max_promo_post — сгенерировать промо-пост для следующей группы\n` +
    `/max_promo_list — список групп с датами публикаций\n\n` +
    `/max_cancel — отменить текущую операцию\n` +
    `/max_help — этот список\n\n` +
    `Посты: каждые 2 дня в 10:00 МСК. Запрос кейса: пн 9:00 МСК.`,
  );
});

bot.command('max_generate', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;

  const pending = await getPendingPost();
  if (pending) {
    return ctx.reply('Уже есть пост на согласовании. Одобрите или отклоните его перед генерацией нового.');
  }

  await ctx.reply('Генерирую пост для MAX, подождите...');

  try {
    const { getPostCount, incrementPostCount } = require('./redis');
    const count = await getPostCount();
    const isCase = count % 2 === 0;
    await incrementPostCount();

    let postText;
    if (isCase) {
      const draft = await getCaseDraft();
      if (draft && draft.task && draft.solution && draft.result) {
        postText = await generateCasePost(draft.task, draft.solution, draft.result);
        await clearCaseDraft();
        await sendForApproval(postText, 'case');
      } else {
        postText = await generateNewsPost();
        await sendForApproval(postText, 'news');
      }
    } else {
      postText = await generateNewsPost();
      await sendForApproval(postText, 'news');
    }
  } catch (err) {
    console.error('[Bot] /max_generate error:', err);
    await ctx.reply(`Ошибка при генерации поста: ${err.message}`);
  }
});

bot.command('max_case', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;

  const state = await getManagerState();
  if (state !== 'idle') {
    return ctx.reply(`Сейчас выполняется другая операция (${state}). Сначала /max_cancel.`);
  }

  await startCaseCollection();
});

bot.command('max_status', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  const state = await getManagerState();
  const post = await getPendingPost();
  const draft = await getCaseDraft();

  let msg = `📊 <b>Статус MAX агента</b>\n\nСостояние: <code>${state}</code>`;
  if (post) msg += `\n\nЕсть пост на согласовании (тип: ${post.type})`;
  if (draft && Object.keys(draft).length) msg += `\n\nЧерновик кейса: ${JSON.stringify(draft)}`;

  await ctx.replyWithHTML(msg);
});

bot.command('max_cancel', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  await setManagerState('idle');
  await ctx.reply('Операция отменена.');
});

// ─── Команды промо ────────────────────────────────────────────────────────────

bot.command('max_promo', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  await ctx.reply('Ищу профильные сообщества MAX через AI, подождите...');
  try {
    const found = await searchGroups();
    const { added, total } = await mergeGroups(found);
    const lines = found.map((g) => `• <b>${g.name}</b> — ${g.link}\n  <i>${g.topic}</i>`).join('\n');
    await ctx.replyWithHTML(
      `🔍 <b>Поиск завершён</b>\n\nНайдено: ${found.length}, добавлено новых: ${added}, всего в базе: ${total}\n\n${lines}\n\nДля генерации промо-поста используйте /max_promo_post`,
    );
  } catch (err) {
    console.error('[Bot] /max_promo error:', err);
    await ctx.reply(`Ошибка при поиске сообществ: ${err.message}`);
  }
});

bot.command('max_promo_post', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;

  const state = await getManagerState();
  if (state !== 'idle') {
    return ctx.reply(`Сейчас активна другая операция (${state}). Сначала /max_cancel.`);
  }

  const groups = await getGroups();
  if (!groups.length) {
    return ctx.reply('База сообществ пуста. Сначала запустите /max_promo для поиска.');
  }

  const group = pickNextGroup(groups);
  if (!group) {
    return ctx.reply('Нет активных сообществ. Проверьте статусы через /max_promo_list.');
  }

  await ctx.replyWithHTML(`Генерирую промо-пост для сообщества <b>${group.name}</b>...`);

  try {
    const postText = await generatePromoPost(group);
    await setPromoPending({ text: postText, group });
    await ctx.replyWithHTML(
      `📣 <b>Промо-пост для сообщества ${group.name}</b>\n${group.link}\n\n${postText}`,
      promoApprovalKeyboard(),
    );
  } catch (err) {
    console.error('[Bot] /max_promo_post error:', err);
    await ctx.reply(`Ошибка при генерации промо-поста: ${err.message}`);
  }
});

bot.command('max_promo_list', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  const groups = await getGroups();
  if (!groups.length) {
    return ctx.reply('База сообществ пуста. Запустите /max_promo для поиска.');
  }

  const formatDate = (iso) => {
    if (!iso) return 'не публиковалась';
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  const lines = groups.map((g, i) => {
    const status = g.status === 'active' ? '🟢' : '⏸️';
    return `${status} ${i + 1}. <b>${g.name}</b>\n   ${g.link}\n   <i>${g.topic}</i>\n   Последняя публикация: ${formatDate(g.lastPublished)}`;
  });

  await ctx.replyWithHTML(
    `📋 <b>База MAX сообществ (${groups.length})</b>\n\n` + lines.join('\n\n'),
  );
});

// ─── Callbacks: промо-согласование ───────────────────────────────────────────

bot.action('max_promo_approve', async (ctx) => {
  await ctx.answerCbQuery();
  const pending = await getPromoPending();
  if (!pending) return ctx.reply('Нет промо-поста в очереди.');

  await setManagerState('confirming_promo_publish');
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply(
    `✅ Отлично! После публикации напишите: в каком сообществе опубликовали?\n(Название или ссылку)\n\n/max_cancel — отменить`,
  );
});

bot.action('max_promo_edit', async (ctx) => {
  await ctx.answerCbQuery();
  await setManagerState('editing_promo');
  await ctx.editMessageReplyMarkup(undefined);
  await ctx.reply('✏️ Отправьте отредактированный текст промо-поста.\n\n/max_cancel — отменить.');
});

bot.action('max_promo_next', async (ctx) => {
  await ctx.answerCbQuery();
  const pending = await getPromoPending();
  const excludeId = pending?.group?.id || null;

  const groups = await getGroups();
  const nextGroup = pickNextGroup(groups, excludeId);
  if (!nextGroup) {
    await clearPromoPending();
    return ctx.reply('Больше нет активных сообществ для выбора.');
  }

  await ctx.editMessageReplyMarkup(undefined);
  await ctx.replyWithHTML(`Генерирую пост для следующего сообщества: <b>${nextGroup.name}</b>...`);

  try {
    const postText = await generatePromoPost(nextGroup);
    await setPromoPending({ text: postText, group: nextGroup });
    await ctx.replyWithHTML(
      `📣 <b>Промо-пост для ${nextGroup.name}</b>\n${nextGroup.link}\n\n${postText}`,
      promoApprovalKeyboard(),
    );
  } catch (err) {
    console.error('[Bot] max_promo_next error:', err);
    await ctx.reply(`Ошибка при генерации поста: ${err.message}`);
  }
});

// ─── Сбор данных для кейса (state machine) ────────────────────────────────────

async function startCaseCollection() {
  await clearCaseDraft();
  await setManagerState('collecting_task');
  await bot.telegram.sendMessage(
    MANAGER_ID,
    `📋 <b>Запрос данных для кейса (MAX)</b>\n\nОпишите задачу заказчика — что было на входе, какая была проблема или цель?\n\n/max_cancel — пропустить на этот раз.`,
    { parse_mode: 'HTML' },
  );
}

// ─── Обработчик входящих сообщений от менеджера ───────────────────────────────

bot.on('text', async (ctx) => {
  if (ctx.from.id !== MANAGER_ID) return;
  if (ctx.message.text.startsWith('/')) return;

  const state = await getManagerState();
  const text = ctx.message.text.trim();

  if (state === 'editing') {
    const currentPost = await getPendingPost();
    if (!currentPost) {
      await setManagerState('idle');
      return ctx.reply('Нет поста для редактирования.');
    }
    await setPendingPost({ ...currentPost, text });
    await setManagerState('idle');
    await ctx.replyWithHTML(
      `📝 <b>Обновлённый пост</b>\n\n${text}`,
      approvalKeyboard(),
    );
    return;
  }

  if (state === 'collecting_task') {
    await setCaseField('task', text);
    await setManagerState('collecting_solution');
    return ctx.reply('Отлично. Теперь опишите решение — что сделали, какие системы запроектировали, почему именно так?');
  }

  if (state === 'collecting_solution') {
    await setCaseField('solution', text);
    await setManagerState('collecting_result');
    return ctx.reply('Последний шаг — результат. Что получил заказчик? Укажите конкретику: сроки, экономию, факты.');
  }

  if (state === 'collecting_result') {
    await setCaseField('result', text);
    await setManagerState('idle');
    await ctx.reply('Генерирую кейс для MAX, подождите...');

    try {
      const draft = await getCaseDraft();
      const postText = await generateCasePost(draft.task, draft.solution, text);
      await clearCaseDraft();
      await sendForApproval(postText, 'case');
    } catch (err) {
      console.error('[Bot] generateCasePost error:', err);
      await ctx.reply(`Ошибка при генерации кейса: ${err.message}\n\nДанные сохранены, попробуйте /max_generate позже.`);
    }
    return;
  }

  if (state === 'confirming_promo_publish') {
    const pending = await getPromoPending();
    if (!pending) {
      await setManagerState('idle');
      return ctx.reply('Нет промо-поста в очереди.');
    }
    await markGroupPublished(pending.group.id, text);
    await clearPromoPending();
    await setManagerState('idle');
    return ctx.reply(`✅ Зафиксировано! Сообщество "${pending.group.name}" — следующая публикация через 14 дней.`);
  }

  if (state === 'editing_promo') {
    const pending = await getPromoPending();
    if (!pending) {
      await setManagerState('idle');
      return ctx.reply('Нет промо-поста для редактирования.');
    }
    await setPromoPending({ ...pending, text });
    await setManagerState('idle');
    await ctx.replyWithHTML(
      `📣 <b>Обновлённый промо-пост для ${pending.group.name}</b>\n${pending.group.link}\n\n${text}`,
      promoApprovalKeyboard(),
    );
    return;
  }

  await ctx.reply('Используйте кнопки одобрения или дождитесь очередного поста от агента.');
});

module.exports = { bot, sendForApproval, startCaseCollection };
