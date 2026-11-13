# Telegram-бот с ИИ

Бот на Node.js ([grammY](https://grammy.dev) + [OpenAI](https://developers.openai.com/api/docs)):

- ведёт диалог с помощью модели **gpt-5.5** (Responses API);
- помнит контекст беседы в каждом чате (через `previous_response_id`, ссылки хранятся в `sessions.json`);
- понимает голосовые сообщения: расшифровывает их моделью **gpt-transcribe** и отвечает на текст.

Команды: `/start` — приветствие, `/new` — начать новый диалог (забыть контекст).

## Запуск

1. Установите Node.js 22+ (проверено на v26.13.1).
2. `npm install`
3. Скопируйте `.env.example` в `.env` и впишите токен от @BotFather и ключ OpenAI API.
4. `npm start`

Необязательные переменные: `OPENAI_MODEL` (по умолчанию `gpt-5.5`), `OPENAI_TRANSCRIBE_MODEL` (по умолчанию `gpt-transcribe`).
Если задана `HTTPS_PROXY`, бот обращается к Telegram и OpenAI через этот прокси.
