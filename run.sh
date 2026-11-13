#!/usr/bin/env bash
# Держит бота запущенным: если процесс упадёт, перезапускает его через 5 секунд
cd "$(dirname "$0")"
export PATH=/usr/local/bin:$PATH
while true; do
  echo "[$(date -u +%FT%TZ)] старт" >> bot.log
  node --env-file=.env bot.js >> bot.log 2>&1
  echo "[$(date -u +%FT%TZ)] бот остановился (код $?), перезапуск через 5 с" >> bot.log
  sleep 5
done
