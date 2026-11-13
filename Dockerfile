# Образ для запуска бота в облаке (Railway, Render, Fly.io и т. п.)
FROM node:26-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY *.js ./

# История диалогов и каталог полей Troon лежат в /app/data.
# Подключите туда постоянный диск (volume) в настройках хостинга, чтобы они не терялись при перезапуске.

# Переменные (BOT_TOKEN, CLAUDE_API_KEY, OPENAI_API_KEY, ALLOWED_USER_IDS) задаются в настройках хостинга
CMD ["node", "bot.js"]
