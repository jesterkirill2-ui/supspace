# Local Telegram Setup

## Що вже реалізовано

- `server.js` піднімає локальний Express-сервер.
- Використовується `telegraf` для прийому webhook-оновлень і відправки повідомлень назад у Telegram.
- `support_dashboard.html` містить вбудовану admin mini panel для:
  - збереження `bot token`
  - введення `public webhook url`
  - виставлення webhook
  - оновлення списку чатів

## Що потрібно встановити локально

1. Встановити Node.js 20+.
2. У папці проєкту виконати:

```bash
npm install
```

## Як запустити локально

```bash
npm start
```

Після цього сторінка буде доступна тут:

```text
http://localhost:3000/support
```

## Як підключити Telegram webhook

Telegram не може стукатись у `localhost`, тому потрібен публічний URL.

Приклад через `ngrok`:

```bash
ngrok http 3000
```

Далі:

1. Скопіювати HTTPS URL з `ngrok`
2. Відкрити `http://localhost:3000/support`
3. У блоці `Telegram Admin` вставити:
   - `Bot Token`
   - `Public Webhook URL`
4. Натиснути `Зберегти ключ`
5. Натиснути `Виставити webhook`

Webhook піде на:

```text
<PUBLIC_WEBHOOK_URL>/telegram/webhook
```

## Локальне збереження

- Налаштування Telegram зберігаються в `storage/telegram-settings.json`
- Чати та повідомлення зберігаються в `storage/telegram-chats.json`

## Поточне обмеження

Якщо Node.js ще не встановлено, сервер і `telegraf` не запустяться. Код уже підготовлений, але залежності потрібно встановити локально.
