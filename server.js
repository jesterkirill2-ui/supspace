const express = require('express');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { Telegraf } = require('telegraf');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const STORAGE_DIR = path.join(__dirname, 'storage');
const SETTINGS_PATH = path.join(STORAGE_DIR, 'telegram-settings.json');
const CHATS_PATH = path.join(STORAGE_DIR, 'telegram-chats.json');

const defaultSettings = {
  botToken: '',
  publicWebhookUrl: '',
  webhookPath: '/telegram/webhook',
  lastWebhookSetAt: '',
  lastError: '',
  botInfo: null
};

function ensureStorage() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }

  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaultSettings, null, 2), 'utf8');
  }

  if (!fs.existsSync(CHATS_PATH)) {
    fs.writeFileSync(CHATS_PATH, JSON.stringify({ chats: [] }, null, 2), 'utf8');
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function getSettings() {
  return { ...defaultSettings, ...readJson(SETTINGS_PATH, defaultSettings) };
}

function saveSettings(nextSettings) {
  writeJson(SETTINGS_PATH, nextSettings);
  return nextSettings;
}

function getChatState() {
  const state = readJson(CHATS_PATH, { chats: [] });
  return { chats: Array.isArray(state.chats) ? state.chats : [] };
}

function saveChatState(nextState) {
  writeJson(CHATS_PATH, nextState);
  return nextState;
}

function initialsFromName(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'TG';
}

function formatRelativeMinutes(minutes) {
  if (minutes <= 0) {
    return 'щойно';
  }

  if (minutes < 60) {
    return `${minutes} хв тому`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours} год тому`;
}

function formatDurationCompact(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function diffMinutes(fromDate) {
  return Math.max(0, Math.floor((Date.now() - fromDate.getTime()) / 60000));
}

function compactText(input, limit) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function messageTextFromUpdate(message) {
  if (!message) {
    return '';
  }
  return (
    message.text ||
    message.caption ||
    (message.sticker ? 'Надіслано стікер' : '') ||
    (message.animation ? 'Надіслано GIF' : '') ||
    (message.video ? 'Надіслано відео' : '') ||
    (message.photo ? 'Надіслано фото' : '') ||
    (message.document ? 'Надіслано файл' : '') ||
    (message.location ? 'Надіслано геолокацію' : '') ||
    'Системне повідомлення'
  );
}

function extractMediaFromMessage(message) {
  if (!message) {
    return null;
  }

  if (message.sticker) {
    const sticker = message.sticker;
    const isVideo = Boolean(sticker.is_video);
    const isAnimated = Boolean(sticker.is_animated);
    const format = isVideo ? 'webm' : isAnimated ? 'tgs' : 'webp';

    return {
      kind: 'sticker',
      fileId: sticker.file_id,
      emoji: sticker.emoji || '',
      setName: sticker.set_name || '',
      format,
      renderAs: isVideo ? 'video' : isAnimated ? 'animated-sticker' : 'image'
    };
  }

  if (message.animation) {
    return {
      kind: 'animation',
      fileId: message.animation.file_id,
      mimeType: message.animation.mime_type || 'video/mp4',
      fileName: message.animation.file_name || 'animation',
      renderAs: 'video'
    };
  }

  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return {
      kind: 'photo',
      fileId: photo.file_id,
      renderAs: 'image'
    };
  }

  if (message.video) {
    return {
      kind: 'video',
      fileId: message.video.file_id,
      mimeType: message.video.mime_type || 'video/mp4',
      fileName: message.video.file_name || 'video',
      renderAs: 'video'
    };
  }

  if (message.document) {
    const mimeType = message.document.mime_type || '';
    if (mimeType.startsWith('image/')) {
      return {
        kind: 'document-image',
        fileId: message.document.file_id,
        mimeType,
        fileName: message.document.file_name || 'image',
        renderAs: 'image'
      };
    }

    if (mimeType.startsWith('video/') || mimeType === 'image/gif') {
      return {
        kind: 'document-video',
        fileId: message.document.file_id,
        mimeType,
        fileName: message.document.file_name || 'media',
        renderAs: 'video'
      };
    }
  }

  return null;
}

function toDashboardChat(chatRecord) {
  const lastMessage = chatRecord.messages[chatRecord.messages.length - 1];
  const lastOutgoingIndex = [...chatRecord.messages]
    .map((message, index) => ({ message, index }))
    .filter((entry) => entry.message.side === 'out')
    .at(-1)?.index ?? -1;

  const pendingIncomingMessages = chatRecord.messages.slice(lastOutgoingIndex + 1).filter((entry) => entry.side === 'in');
  const lastPendingIncomingMessage = pendingIncomingMessages.at(-1) || null;
  const waitingMinutes = lastPendingIncomingMessage
    ? diffMinutes(new Date(lastPendingIncomingMessage.timestamp))
    : 0;
  const waitingSeconds = lastPendingIncomingMessage
    ? Math.max(0, Math.floor((Date.now() - new Date(lastPendingIncomingMessage.timestamp).getTime()) / 1000))
    : 0;
  const hasWait = Boolean(lastPendingIncomingMessage);
  const hasOutgoing = lastOutgoingIndex >= 0;
  const isBrandNew = !hasOutgoing && hasWait;

  return {
    id: chatRecord.id,
    name: chatRecord.name,
    initials: chatRecord.initials || initialsFromName(chatRecord.name),
    time: formatRelativeMinutes(diffMinutes(new Date(chatRecord.lastActivityAt))),
    unread: chatRecord.unread || 0,
    status: hasWait ? 'Очікує відповіді' : 'Активний',
    statusTone: hasWait ? 'warn' : 'info',
    tag: chatRecord.source || 'Telegram',
    listBadge: isBrandNew ? 'NEW' : hasWait ? 'WAIT' : 'LIVE',
    listBadgeTone: isBrandNew ? 'new' : hasWait ? 'wait' : 'info',
    sla: hasWait ? `SLA ${waitingMinutes} хв` : '',
    waitTime: hasWait ? `Без відп. ${formatDurationCompact(waitingSeconds)}` : '',
    waitStartedAt: lastPendingIncomingMessage ? lastPendingIncomingMessage.timestamp : '',
    lastActivityAt: chatRecord.lastActivityAt,
    subtitle: `Telegram ID: ${chatRecord.id} • ${chatRecord.username ? `@${chatRecord.username} • ` : ''}Канал: Telegram Bot`,
    messages: chatRecord.messages.map((entry) => ({
      side: entry.side,
      author: entry.author,
      time: new Date(entry.timestamp).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
      text: entry.text
      ,
      media: entry.media || null
    }))
  };
}

function getDashboardPayload() {
  const state = getChatState();
  const chats = state.chats
    .slice()
    .sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt))
    .map(toDashboardChat);

  return {
    settings: sanitizeSettings(getSettings()),
    chats
  };
}

function sanitizeSettings(settings) {
  return {
    hasBotToken: Boolean(settings.botToken),
    publicWebhookUrl: settings.publicWebhookUrl || '',
    webhookPath: settings.webhookPath || defaultSettings.webhookPath,
    lastWebhookSetAt: settings.lastWebhookSetAt || '',
    lastError: settings.lastError || '',
    botInfo: settings.botInfo || null
  };
}

let bot = null;

function buildBot(token) {
  if (!token) {
    return null;
  }

  const instance = new Telegraf(token);

  instance.on('message', async (ctx) => {
    persistIncomingMessage(ctx.update.message);
  });

  return instance;
}

function getBot() {
  const settings = getSettings();

  if (!settings.botToken) {
    bot = null;
    return null;
  }

  if (bot) {
    return bot;
  }

  bot = buildBot(settings.botToken);
  return bot;
}

function resetBot() {
  bot = null;
}

function persistIncomingMessage(message) {
  if (!message || !message.chat) {
    return;
  }

  const state = getChatState();
  const text = messageTextFromUpdate(message);
  const media = extractMediaFromMessage(message);
  const chatId = String(message.chat.id);
  const fullName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ').trim()
    || message.chat.title
    || message.from?.username
    || `Chat ${chatId}`;

  let chat = state.chats.find((entry) => entry.id === chatId);
  if (!chat) {
    chat = {
      id: chatId,
      name: fullName,
      initials: initialsFromName(fullName),
      username: message.from?.username || '',
      source: 'Telegram',
      unread: 0,
      lastActivityAt: new Date().toISOString(),
      messages: []
    };
    state.chats.push(chat);
  }

  chat.name = fullName;
  chat.initials = initialsFromName(fullName);
  chat.username = message.from?.username || chat.username || '';
  chat.unread += 1;
  chat.lastActivityAt = new Date((message.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();
  chat.messages.push({
    id: message.message_id,
    side: 'in',
    author: fullName,
    text,
    media,
    timestamp: chat.lastActivityAt
  });

  saveChatState(state);
}

app.use(express.json({ limit: '1mb' }));
app.use('/storage', express.static(STORAGE_DIR));

app.get('/', (req, res) => {
  res.redirect('/support');
});

app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'support_dashboard.html'));
});

app.get('/suphub', (req, res) => {
  res.sendFile(path.join(__dirname, 'suphub_dashboard.html'));
});

app.get('/forecast', (req, res) => {
  res.sendFile(path.join(__dirname, 'forecast_dashboard.html'));
});

app.get('/api/dashboard', (req, res) => {
  res.json(getDashboardPayload());
});

app.get('/api/admin/settings', (req, res) => {
  res.json(sanitizeSettings(getSettings()));
});

app.post('/api/admin/settings', async (req, res) => {
  const current = getSettings();
  const botToken = String(req.body.botToken || '').trim();
  const publicWebhookUrl = String(req.body.publicWebhookUrl || '').trim().replace(/\/$/, '');
  const webhookPath = String(req.body.webhookPath || current.webhookPath || defaultSettings.webhookPath).trim() || defaultSettings.webhookPath;

  const nextSettings = {
    ...current,
    botToken,
    publicWebhookUrl,
    webhookPath,
    lastError: ''
  };

  saveSettings(nextSettings);
  resetBot();

  if (botToken) {
    try {
      const liveBot = getBot();
      const botInfo = await liveBot.telegram.getMe();
      saveSettings({ ...nextSettings, botInfo });
      return res.json({ ok: true, settings: sanitizeSettings(getSettings()) });
    } catch (error) {
      saveSettings({ ...nextSettings, lastError: error.message, botInfo: null });
      resetBot();
      return res.status(400).json({ ok: false, error: `Не вдалося перевірити токен: ${error.message}` });
    }
  }

  return res.json({ ok: true, settings: sanitizeSettings(getSettings()) });
});

app.post('/api/admin/webhook/register', async (req, res) => {
  const settings = getSettings();
  if (!settings.botToken) {
    return res.status(400).json({ ok: false, error: 'Спочатку збережіть bot token.' });
  }

  if (!settings.publicWebhookUrl) {
    return res.status(400).json({ ok: false, error: 'Для webhook потрібен публічний URL тунелю або сервера.' });
  }

  try {
    const liveBot = getBot();
    const webhookUrl = `${settings.publicWebhookUrl}${settings.webhookPath}`;
    await liveBot.telegram.setWebhook(webhookUrl);

    const nextSettings = {
      ...settings,
      lastWebhookSetAt: new Date().toISOString(),
      lastError: ''
    };
    saveSettings(nextSettings);

    return res.json({
      ok: true,
      webhookUrl,
      settings: sanitizeSettings(nextSettings)
    });
  } catch (error) {
    const nextSettings = { ...settings, lastError: error.message };
    saveSettings(nextSettings);
    resetBot();
    return res.status(500).json({ ok: false, error: `Не вдалося виставити webhook: ${error.message}` });
  }
});

app.post(defaultSettings.webhookPath, async (req, res) => {
  const liveBot = getBot();
  if (!liveBot) {
    return res.status(400).json({ ok: false, error: 'Bot token не налаштовано.' });
  }

  try {
    await liveBot.handleUpdate(req.body, res);
  } catch (error) {
    const settings = getSettings();
    saveSettings({ ...settings, lastError: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/admin/messages/outgoing', async (req, res) => {
  const { chatId, text } = req.body || {};
  if (!chatId || !String(text || '').trim()) {
    return res.status(400).json({ ok: false, error: 'Потрібні chatId і текст повідомлення.' });
  }

  const state = getChatState();
  const chat = state.chats.find((entry) => entry.id === String(chatId));
  if (!chat) {
    return res.status(404).json({ ok: false, error: 'Чат не знайдено.' });
  }

  const timestamp = new Date().toISOString();

  try {
    const liveBot = getBot();
    if (liveBot) {
      await liveBot.telegram.sendMessage(chat.id, String(text).trim());
    }
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Не вдалося відправити повідомлення в Telegram: ${error.message}` });
  }

  chat.unread = 0;
  chat.lastActivityAt = timestamp;
  chat.messages.push({
    id: `local-${Date.now()}`,
    side: 'out',
    author: 'Спеціаліст',
    text: String(text).trim(),
    media: null,
    timestamp
  });

  saveChatState(state);
  return res.json({ ok: true });
});

app.get('/api/telegram/file/:fileId', async (req, res) => {
  try {
    const settings = getSettings();
    if (!settings.botToken) {
      return res.status(400).send('Bot token не налаштовано.');
    }

    const liveBot = getBot();
    if (!liveBot) {
      return res.status(400).send('Telegram bot не готовий.');
    }

    const file = await liveBot.telegram.getFile(req.params.fileId);
    if (!file?.file_path) {
      return res.status(404).send('Файл не знайдено.');
    }

    const telegramUrl = `https://api.telegram.org/file/bot${settings.botToken}/${file.file_path}`;
    https.get(telegramUrl, (telegramResponse) => {
      if (telegramResponse.statusCode && telegramResponse.statusCode >= 400) {
        res.status(telegramResponse.statusCode).end();
        telegramResponse.resume();
        return;
      }

      const contentType = telegramResponse.headers['content-type'];
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }

      telegramResponse.pipe(res);
    }).on('error', (error) => {
      res.status(500).send(error.message);
    });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

ensureStorage();

app.listen(PORT, HOST, () => {
  console.log(`SUP chat dashboard is running on http://localhost:${PORT}/support`);
});
