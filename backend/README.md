# AIVEL VPN — самостоятельный backend

Это самостоятельный backend для AIVEL VPN. Он обслуживает Mini App API, проверяет Telegram `initData`, создаёт Platega-платежи и после подтверждённого callback синхронизирует подписку с Marzban. Статус, ключ и реферальная статистика возвращаются только владельцу Telegram-аккаунта.

## Требования

- Node.js 24+ (образ `node:24-bookworm-slim` включает встроенный `node:sqlite`)
- Существующая база SQLite с таблицами подписок и заказов
- Существующие серверные переменные Telegram, Marzban, Platega и public subscription origin

## Переменные окружения

- `AIVEL_API_HOST` — по умолчанию `127.0.0.1`
- `AIVEL_API_PORT` — по умолчанию `8080`
- `AIVEL_MINIAPP_ORIGIN` — точный HTTPS origin страницы Mini App, без пути
- `AIVEL_BOT_TOKEN` — токен бота, только на сервере
- `AIVEL_DB` — **абсолютный путь к текущей базе**; до cutover проверь прежнее значение и не создавай новую пустую БД
- `AIVEL_MARZBAN_API_ORIGIN`, `AIVEL_MARZBAN_USERNAME`, `AIVEL_MARZBAN_PASSWORD`, `AIVEL_MARZBAN_INBOUND`, `AIVEL_SUBSCRIPTION_ORIGIN`
- `AIVEL_PLATEGA_MERCHANT_ID`, `AIVEL_PLATEGA_SECRET`
- `AIVEL_PLATEGA_CALLBACK_PATH` — по умолчанию `/platega/callback`

Не помещай секреты в GitHub. Для контейнера подключи защищённый env-файл и тот же каталог с базой данных, который использует текущий сервис. Сначала проверь DB path и резервную копию; не переключай production на новый процесс, пока он не проходит health, Telegram auth, Marzban и тестовый платёжный callback.

## Маршруты

- `GET /health`
- `POST /miniapp/subscription` — состояние подписки и реферальные счётчики
- `POST /miniapp/referral` — регистрация Telegram start-параметра и счётчики
- `POST /miniapp/trial` — ровно 2 дня / 5 ГБ
- `POST /miniapp/create-payment` — периоды 30/90/180 дней, методы Platega 2/10
- `POST /platega/callback` — проверка Platega по секретным заголовкам и повторная проверка транзакции API

Триал использует `startTrial`, где уникальность аккаунта и срок 2 дня уже обеспечены таблицей БД. Оплата подтверждается только по актуальному статусу Platega `CONFIRMED` и совпадающим заказу, payload и сумме; повторный callback идемпотентен на уровне базы.

