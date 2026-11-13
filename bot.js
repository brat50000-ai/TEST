import fs from 'node:fs';
import path from 'node:path';
import { Bot } from 'grammy';
import Anthropic, { toFile as toClaudeFile } from '@anthropic-ai/sdk';
import OpenAI, { toFile as toOpenAIFile } from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent } from 'undici';

const { BOT_TOKEN, CLAUDE_API_KEY, OPENAI_API_KEY } = process.env;
if (!BOT_TOKEN || !CLAUDE_API_KEY) {
  console.error('Не заданы BOT_TOKEN и/или CLAUDE_API_KEY. Создайте файл .env (см. .env.example).');
  process.exit(1);
}

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe';
const ALLOWED_USERS = new Set(
  (process.env.ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
);
const MAX_FILE_BYTES = 20 * 1024 * 1024; // лимит Telegram Bot API на скачивание файлов

const SYSTEM_PROMPT =
  'Ты — личный ИИ-ассистент в Telegram. Веди живой диалог, отвечай по существу и на языке пользователя. ' +
  'Пользователь может присылать документы (PDF, текстовые файлы, таблицы CSV), фотографии и голосовые сообщения ' +
  '(голосовые приходят уже расшифрованными в текст). Анализируй их содержимое и опирайся на всю историю разговора. ' +
  'Telegram показывает ответ как обычный текст, поэтому не используй Markdown-разметку (звёздочки, решётки, таблицы): ' +
  'для списков используй простые строки с тире или цифрами.';

// Если задан HTTPS-прокси (например, в облачном окружении) — ходим через него
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
const fetchOptions = dispatcher ? { fetchOptions: { dispatcher } } : {};
const httpFetch = (url, init = {}) => fetch(url, { ...init, dispatcher });

const bot = new Bot(BOT_TOKEN, {
  client: proxy ? { baseFetchConfig: { agent: new HttpsProxyAgent(proxy), compress: true } } : {},
});
const claude = new Anthropic({ apiKey: CLAUDE_API_KEY, ...fetchOptions });
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY, ...fetchOptions }) : null;

// ---------- Память диалогов: chatId -> массив сообщений Claude ----------
const DATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
const histories = new Map(
  fs.existsSync(HISTORY_FILE) ? Object.entries(JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))) : [],
);
function saveHistories() {
  const tmp = `${HISTORY_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(histories)));
  fs.renameSync(tmp, HISTORY_FILE);
}

// Запросы одного чата обрабатываем строго по очереди, чтобы не перепутать контекст
const queues = new Map();
function enqueue(chatId, task) {
  const next = (queues.get(chatId) || Promise.resolve()).then(task, task);
  queues.set(chatId, next.catch(() => {}));
  return next;
}

// ---------- Claude ----------
async function askClaude(chatId, content) {
  const key = String(chatId);
  const messages = histories.get(key) || [];
  // История только дополняется (так требует сохранение рассуждений модели между ходами)
  const request = [...messages, { role: 'user', content }];

  const response = await claude.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: request,
    output_config: { effort: 'low' },
    cache_control: { type: 'ephemeral' },
    // Длинные диалоги автоматически сжимаются на стороне Claude, контекст не теряется
    context_management: { edits: [{ type: 'compact_20260112' }] },
    // Если модель откажется по соображениям безопасности, запрос повторит рекомендованная запасная модель
    fallbacks: 'default',
    betas: ['compact-2026-01-12', 'server-side-fallback-2026-07-01'],
  });

  if (response.stop_reason === 'refusal') {
    // Отказ не сохраняем в историю, чтобы он не мешал следующим вопросам
    return 'Извините, на этот запрос я ответить не могу. Попробуйте переформулировать.';
  }

  request.push({ role: 'assistant', content: response.content });
  histories.set(key, request);
  saveHistories();

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (response.stop_reason === 'max_tokens') return `${text}\n\n(ответ обрезан — слишком длинный)`;
  return text || 'Не получилось сформулировать ответ, попробуйте переформулировать вопрос.';
}

// ---------- Файлы из Telegram ----------
async function downloadTelegramFile(fileId) {
  const file = await bot.api.getFile(fileId);
  const res = await httpFetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`Не удалось скачать файл: HTTP ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), filePath: file.file_path };
}

const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.yaml', '.yml', '.log', '.ini', '.sql',
  '.js', '.mjs', '.ts', '.py', '.java', '.go', '.rb', '.php', '.cs', '.c', '.cpp', '.h', '.sh', '.css',
]);

class UserFacingError extends Error {}

// Превращает файл в блок контента для Claude
async function fileToContentBlock({ fileId, fileName, mimeType, fileSize }) {
  if (fileSize && fileSize > MAX_FILE_BYTES) throw new UserFacingError('Файл больше 20 МБ — Telegram не даёт ботам скачивать такие файлы.');
  const ext = path.extname(fileName || '').toLowerCase();
  const { buffer } = await downloadTelegramFile(fileId);

  if (mimeType === 'application/pdf' || ext === '.pdf') {
    const uploaded = await claude.files.upload({ file: await toClaudeFile(buffer, fileName || 'document.pdf', { type: 'application/pdf' }) });
    return { type: 'document', source: { type: 'file', file_id: uploaded.id }, title: fileName || 'document.pdf' };
  }
  const imageType = IMAGE_TYPES[ext] || (mimeType?.startsWith('image/') && Object.values(IMAGE_TYPES).includes(mimeType) ? mimeType : null);
  if (imageType) {
    const uploaded = await claude.files.upload({ file: await toClaudeFile(buffer, fileName || `image${ext || '.jpg'}`, { type: imageType }) });
    return { type: 'image', source: { type: 'file', file_id: uploaded.id } };
  }
  if (TEXT_EXTENSIONS.has(ext) || mimeType?.startsWith('text/') || mimeType === 'application/json') {
    return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: buffer.toString('utf8') }, title: fileName || 'file.txt' };
  }
  throw new UserFacingError('Этот формат я пока не читаю. Пришлите PDF, картинку или текстовый файл (txt, csv, json, md и т. п.). Документы Word/Excel можно сохранить в PDF или CSV.');
}

// ---------- Голосовые: расшифровка через OpenAI ----------
async function transcribe(fileId) {
  if (!openai) throw new UserFacingError('Расшифровка голосовых не настроена (нет OPENAI_API_KEY).');
  const { buffer, filePath } = await downloadTelegramFile(fileId);
  const name = (filePath.split('/').pop() || 'voice.ogg').replace(/\.oga$/, '.ogg');
  const result = await openai.audio.transcriptions.create({ file: await toOpenAIFile(buffer, name), model: TRANSCRIBE_MODEL });
  return result.text?.trim();
}

// ---------- Обработка сообщений ----------
// Telegram ограничивает длину сообщения 4096 символами
async function replyLong(ctx, text) {
  for (let i = 0; i < text.length; i += 4000) await ctx.reply(text.slice(i, i + 4000));
}

function handle(ctx, buildContent) {
  return enqueue(ctx.chat.id, async () => {
    ctx.replyWithChatAction('typing').catch(() => {});
    const typing = setInterval(() => ctx.replyWithChatAction('typing').catch(() => {}), 4000);
    try {
      const content = await buildContent();
      if (!content) return await ctx.reply('Не удалось разобрать сообщение 🙁');
      await replyLong(ctx, await askClaude(ctx.chat.id, content));
    } catch (err) {
      if (err instanceof UserFacingError) return await ctx.reply(err.message);
      console.error('Ошибка обработки:', err);
      await ctx.reply('Произошла ошибка при обращении к ИИ. Попробуйте ещё раз чуть позже.');
    } finally {
      clearInterval(typing);
    }
  });
}

// Доступ только для разрешённых пользователей
bot.use(async (ctx, next) => {
  const userId = String(ctx.from?.id ?? '');
  if (ALLOWED_USERS.size === 0 || ALLOWED_USERS.has(userId)) return next();
  console.warn(`Отклонён пользователь ${userId} (@${ctx.from?.username ?? '-'})`);
  if (ctx.chat?.type === 'private') await ctx.reply(`Это личный бот, доступ закрыт. Ваш ID: ${userId}`);
});

bot.command('start', (ctx) =>
  ctx.reply(
    'Привет! Я твой личный бот на Claude. Пиши вопросы, присылай голосовые, фото и документы (PDF, txt, csv и др.) — ' +
      'я помню наш разговор. /new — начать новый диалог.',
  ),
);
bot.command('new', (ctx) => {
  histories.delete(String(ctx.chat.id));
  saveHistories();
  return ctx.reply('Начинаем новый диалог — предыдущий контекст забыт.');
});

bot.on('message:text', (ctx) => handle(ctx, () => ctx.message.text));

bot.on(['message:voice', 'message:audio', 'message:video_note'], (ctx) =>
  handle(ctx, async () => {
    const media = ctx.message.voice || ctx.message.audio || ctx.message.video_note;
    if (media.file_size > MAX_FILE_BYTES) throw new UserFacingError('Запись больше 20 МБ — слишком большая.');
    const text = await transcribe(media.file_id);
    if (!text) return null;
    await ctx.reply(`🎤 ${text}`, { reply_parameters: { message_id: ctx.message.message_id } });
    return text;
  }),
);

bot.on('message:photo', (ctx) =>
  handle(ctx, async () => {
    const photo = ctx.message.photo.at(-1); // самое большое разрешение
    const block = await fileToContentBlock({ fileId: photo.file_id, fileName: 'photo.jpg', mimeType: 'image/jpeg', fileSize: photo.file_size });
    return [block, { type: 'text', text: ctx.message.caption || 'Что на этом изображении?' }];
  }),
);

bot.on('message:document', (ctx) =>
  handle(ctx, async () => {
    const doc = ctx.message.document;
    const block = await fileToContentBlock({ fileId: doc.file_id, fileName: doc.file_name, mimeType: doc.mime_type, fileSize: doc.file_size });
    return [block, { type: 'text', text: ctx.message.caption || `Я отправил файл «${doc.file_name}». Кратко расскажи, что в нём.` }];
  }),
);

bot.on('message', (ctx) => ctx.reply('Я понимаю текст, голосовые, фото и документы.'));

bot.catch((err) => console.error('Ошибка бота:', err));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

await bot.api.setMyCommands([
  { command: 'new', description: 'Начать новый диалог' },
  { command: 'start', description: 'О боте' },
]);
bot.start({
  onStart: (me) =>
    console.log(
      `Бот @${me.username} запущен (диалог: ${CLAUDE_MODEL}, голосовые: ${openai ? TRANSCRIBE_MODEL : 'выкл'}, ` +
        `доступ: ${ALLOWED_USERS.size ? [...ALLOWED_USERS].join(',') : 'все'})`,
    ),
});
