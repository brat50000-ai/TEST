# Telegram-бот

Простой бот на Node.js ([grammY](https://grammy.dev)): на любое сообщение отвечает «Привет! Я твой личный бот».

## Запуск

1. Установите Node.js 20+ (проверено на v26.13.1).
2. `npm install`
3. Скопируйте `.env.example` в `.env` и впишите токен от @BotFather.
4. `npm start`

Если задана переменная `HTTPS_PROXY`, бот подключается к Telegram через этот прокси.
