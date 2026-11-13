import fs from 'node:fs';
import { Bot } from 'grammy';
import OpenAI, { toFile } from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent } from 'undici';

const { BOT_TOKEN, OPENAI_API_KEY } = process.env;
if (!BOT_TOKEN || !OPENAI_API_KEY) {
  console.error('Не заданы BOT_TOKEN и/или OPENAI_API_KEY. Создайте файл .env (см. .env.example).');
  process.exit(1);
}

const CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe';
const INSTRUCTIONS =
  'Ты — дружелюбный личный ассистент в Telegram. Отвечай по существу, ясно и на языке пользователя. ' +
  'Пиши обычным текстом без Markdown-разметки.';

// Если задан HTTPS-прокси (например, в облачном окружении) — ходим через него
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
// Встроенный fetch Node.js + прокси-диспетчер undici (undici.fetch несовместим с загрузкой файлов в SDK OpenAI)
const httpFetch = (url, init = {}) => fetch(url, { ...init, dispatcher });

const bot = new Bot(BOT_TOKEN, {
  client: proxy ? { baseFetchConfig: { agent: new HttpsProxyAgent(proxy), compress: true } } : {},
});

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  ...(dispatcher && { fetchOptions: { dispatcher } }),
});

// Память диалогов: chatId -> id последнего ответа модели (previous_response_id).
// Сама история хранится на стороне OpenAI, здесь только ссылки на неё.
const SESSIONS_FILE = new URL('./sessions.json', import.meta.url);
const sessions = new Map(
  fs.existsSync(SESSIONS_FILE) ? Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))) : [],
);
const saveSessions = () =>
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2));

// Запросы одного чата обрабатываем строго по очереди, чтобы не перепутать контекст
const queues = new Map();
function enqueue(chatId, task) {
  const next = (queues.get(chatId) || Promise.resolve()).then(task, task);
  queues.set(chatId, next.catch(() => {}));
  return next;
}

async function ask(chatId, text) {
  const params = {
    model: CHAT_MODEL,
    instructions: INSTRUCTIONS,
    input: text,
    reasoning: { effort: 'low' },
  };
  const previous = sessions.get(String(chatId));
  let response;
  try {
    response = await openai.responses.create({ ...params, previous_response_id: previous });
  } catch (err) {
    // Сохранённый ответ мог устареть (OpenAI хранит его ограниченное время) — начинаем заново
    if (!previous || (err?.status !== 400 && err?.status !== 404)) throw err;
    console.warn('Контекст недоступен, начинаю новый диалог:', err.message);
    response = await openai.responses.create(params);
  }
  sessions.set(String(chatId), response.id);
  saveSessions();
  return response.output_text?.trim() || 'Не получилось сформулировать ответ, попробуйте переформулировать вопрос.';
}

async function transcribe(fileId) {
  const file = await bot.api.getFile(fileId);
  const res = await httpFetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`Не удалось скачать голосовое: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const name = file.file_path.split('/').pop() || 'voice.ogg';
  const result = await openai.audio.transcriptions.create({
    file: await toFile(buffer, name.endsWith('.oga') ? name.replace(/\.oga$/, '.ogg') : name),
    model: TRANSCRIBE_MODEL,
  });
  return result.text?.trim();
}

// Telegram ограничивает длину сообщения 4096 символами
async function replyLong(ctx, text) {
  for (let i = 0; i < text.length; i += 4000) await ctx.reply(text.slice(i, i + 4000));
}

async function handle(ctx, getText) {
  const chatId = ctx.chat.id;
  return enqueue(chatId, async () => {
    const typing = setInterval(() => ctx.replyWithChatAction('typing').catch(() => {}), 4000);
    ctx.replyWithChatAction('typing').catch(() => {});
    try {
      const text = await getText();
      if (!text) return ctx.reply('Не удалось разобрать сообщение 🙁');
      await replyLong(ctx, await ask(chatId, text));
    } catch (err) {
      console.error('Ошибка обработки:', err);
      await ctx.reply('Произошла ошибка при обращении к ИИ. Попробуйте ещё раз чуть позже.');
    } finally {
      clearInterval(typing);
    }
  });
}

bot.command('start', (ctx) =>
  ctx.reply('Привет! Я твой личный бот с ИИ. Задай любой вопрос текстом или голосом. /new — начать новый диалог.'),
);
bot.command('new', (ctx) => {
  sessions.delete(String(ctx.chat.id));
  saveSessions();
  return ctx.reply('Начинаем новый диалог — предыдущий контекст забыт.');
});

bot.on('message:text', (ctx) => handle(ctx, () => ctx.message.text));

bot.on(['message:voice', 'message:audio'], (ctx) =>
  handle(ctx, async () => {
    const media = ctx.message.voice || ctx.message.audio;
    if (media.file_size > 20 * 1024 * 1024) throw new Error('Файл больше 20 МБ');
    const text = await transcribe(media.file_id);
    if (text) await ctx.reply(`🎤 ${text}`, { reply_parameters: { message_id: ctx.message.message_id } });
    return text;
  }),
);

bot.on('message', (ctx) => ctx.reply('Я понимаю текстовые и голосовые сообщения.'));

bot.catch((err) => console.error('Ошибка бота:', err));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

bot.start({
  onStart: (me) => console.log(`Бот @${me.username} запущен (модель ${CHAT_MODEL}, распознавание ${TRANSCRIBE_MODEL})`),
});
