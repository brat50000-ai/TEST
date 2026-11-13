import { Bot } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Не задан BOT_TOKEN. Создайте файл .env (см. .env.example).');
  process.exit(1);
}

// Если задан HTTPS-прокси (например, в облачном окружении) — ходим через него
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const bot = new Bot(token, {
  client: proxy ? { baseFetchConfig: { agent: new HttpsProxyAgent(proxy), compress: true } } : {},
});

// Отвечаем на любое сообщение
bot.on('message', (ctx) => ctx.reply('Привет! Я твой личный бот'));

bot.catch((err) => console.error('Ошибка бота:', err));

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

bot.start({
  onStart: (me) => console.log(`Бот @${me.username} запущен`),
});
