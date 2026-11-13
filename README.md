# Telegram-бот с ИИ

Личный бот на Node.js ([grammY](https://grammy.dev)):

- ведёт диалог через **Claude Sonnet 5.5** (Claude API) и помнит разговор (история хранится в `data/history.json`,
  длинные диалоги автоматически сжимаются на стороне Claude);
- читает документы: PDF, картинки/фото, текстовые файлы (txt, csv, json, md, код и т. п.);
- понимает голосовые: расшифровывает их моделью OpenAI **gpt-transcribe** и отвечает на текст;
- отвечает только пользователям из `ALLOWED_USER_IDS`.

Команды: `/start` — о боте, `/new` — начать новый диалог.

## Запуск

1. Установите Node.js 22+ (проверено на v26.13.1).
2. `npm install`
3. Скопируйте `.env.example` в `.env` и заполните: токен от @BotFather, ключ Claude API, ключ OpenAI API,
   свой Telegram ID (бот покажет его, если написать ему с чужого аккаунта).
4. `npm start`

Необязательные переменные: `CLAUDE_MODEL` (по умолчанию `claude-sonnet-5-5`),
`OPENAI_TRANSCRIBE_MODEL` (по умолчанию `gpt-transcribe`).
Если задана `HTTPS_PROXY`, бот обращается к Telegram, Claude и OpenAI через этот прокси.
