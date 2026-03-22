const express = require('express');
const crypto = require('crypto');
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
const USERS_PATH = path.join(STORAGE_DIR, 'users.json');
const SESSION_COOKIE = 'sup_session';
const sessions = new Map();

const defaultSettings = {
  botToken: '',
  publicWebhookUrl: '',
  webhookPath: '/telegram/webhook',
  assignmentStrategy: 'load-balanced-priority',
  greetingTemplate: 'Добрий день! З вами спеціаліст {specialistName}, я зроблю все можливе щоб вам допомогти :)',
  closingTemplate: 'Якщо будуть питання, звертайтесь до наших офіційних каналів комунікації! Дякуємо за звернення, та гарного {timeOfDay} :)',
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

  if (!fs.existsSync(USERS_PATH)) {
    const seedUsers = {
      users: [
        createStoredUser({
          id: 'admin-1',
          username: 'admin',
          fullName: 'System Administrator',
          role: 'administrator',
          password: 'admin123'
        }),
        createStoredUser({
          id: 'specialist-1',
          username: 'specialist',
          fullName: 'Support Specialist',
          role: 'specialist',
          password: 'specialist123'
        })
      ]
    };
    fs.writeFileSync(USERS_PATH, JSON.stringify(seedUsers, null, 2), 'utf8');
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

function createPasswordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !password) {
    return false;
  }
  const [salt, hash] = String(storedHash).split(':');
  if (!salt || !hash) {
    return false;
  }
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
}

function normalizeAvailabilityStatus(status) {
  return ['online', 'break', 'offline'].includes(status) ? status : 'online';
}

function createStoredUser({ id = crypto.randomUUID(), username, fullName, role, password, availabilityStatus = 'online' }) {
  return {
    id,
    username: String(username || '').trim().toLowerCase(),
    fullName: String(fullName || '').trim(),
    role: role === 'administrator' ? 'administrator' : 'specialist',
    availabilityStatus: normalizeAvailabilityStatus(availabilityStatus),
    passwordHash: createPasswordHash(password),
    createdAt: new Date().toISOString()
  };
}

function getUserState() {
  const state = readJson(USERS_PATH, { users: [] });
  const users = Array.isArray(state.users) ? state.users : [];
  return {
    users: users.map((user) => ({
      ...user,
      availabilityStatus: normalizeAvailabilityStatus(user.availabilityStatus)
    }))
  };
}

function saveUserState(nextState) {
  writeJson(USERS_PATH, nextState);
  return nextState;
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    availabilityStatus: normalizeAvailabilityStatus(user.availabilityStatus),
    createdAt: user.createdAt
  };
}

function getSpecialistUsers() {
  return getUserState().users
    .filter((user) => normalizeAvailabilityStatus(user.availabilityStatus) === 'online')
    .map(sanitizeUser);
}

function getOnlineSpecialists(userState = getUserState()) {
  return userState.users
    .filter((user) => user.role === 'specialist' && normalizeAvailabilityStatus(user.availabilityStatus) === 'online')
    .map(sanitizeUser);
}

function getOnlineAssignableUsers(userState = getUserState()) {
  return userState.users
    .filter((user) =>
      (user.role === 'specialist' || user.role === 'administrator') &&
      normalizeAvailabilityStatus(user.availabilityStatus) === 'online'
    )
    .map(sanitizeUser);
}

function getActiveChats(state = getChatState()) {
  return state.chats.filter((chat) => (chat.threadStatus || 'active') !== 'completed');
}

function countActiveChatsForUser(state, userId) {
  return getActiveChats(state).filter((chat) => chat.assignedUserId === userId).length;
}

function getLatestHandledSpecialistId(state, telegramChatId, excludedChatId = '') {
  return state.chats
    .filter((chat) =>
      String(chat.telegramChatId || chat.id) === String(telegramChatId) &&
      chat.id !== excludedChatId &&
      chat.assignedUserId
    )
    .sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt))[0]?.assignedUserId || '';
}

function pickBalancedAssignee(state, telegramChatId, excludedChatId = '') {
  const candidates = getOnlineSpecialists();
  if (!candidates.length) {
    return null;
  }

  const candidateLoads = candidates.map((user) => ({
    user,
    load: countActiveChatsForUser(state, user.id)
  }));
  const minLoad = Math.min(...candidateLoads.map((entry) => entry.load));
  const lowestLoadCandidates = candidateLoads.filter((entry) => entry.load === minLoad);
  const preferredUserId = getLatestHandledSpecialistId(state, telegramChatId, excludedChatId);
  const preferredEntry = lowestLoadCandidates.find((entry) => entry.user.id === preferredUserId);

  if (preferredEntry) {
    return preferredEntry.user;
  }

  const randomIndex = Math.floor(Math.random() * lowestLoadCandidates.length);
  return lowestLoadCandidates[randomIndex].user;
}

function assignChatRecord(chat, user) {
  chat.assignedUserId = user?.id || '';
  chat.assignedUserName = user?.fullName || '';
}

function applyAutomaticAssignment(state, chat) {
  const settings = getSettings();
  if ((settings.assignmentStrategy || defaultSettings.assignmentStrategy) !== 'load-balanced-priority') {
    return;
  }

  const assignee = pickBalancedAssignee(state, chat.telegramChatId || chat.id, chat.id);
  assignChatRecord(chat, assignee);
}

async function sendGreetingForAssignedChat(chat) {
  if (!chat?.assignedUserId || chat.greetingSentAt) {
    return;
  }

  try {
    const liveBot = getBot();
    if (!liveBot) {
      return;
    }

    const greetingMessage = buildGreetingMessage(chat.assignedUserName || 'спеціаліст');
    const timestamp = new Date().toISOString();
    await liveBot.telegram.sendMessage(chat.telegramChatId || chat.id, greetingMessage);
    chat.greetingSentAt = timestamp;
    chat.lastActivityAt = timestamp;
    chat.messages.push({
      id: `greeting-${Date.now()}`,
      side: 'out',
      author: chat.assignedUserName || 'Спеціаліст',
      text: greetingMessage,
      media: null,
      timestamp
    });
  } catch (error) {
    return;
  }
}

function rebalanceChatsForUnavailableUser(unavailableUserId) {
  const state = getChatState();
  const chatsToReassign = getActiveChats(state).filter((chat) => chat.assignedUserId === unavailableUserId);

  chatsToReassign.forEach((chat) => {
    const assignee = pickBalancedAssignee(state, chat.telegramChatId || chat.id, chat.id);
    assignChatRecord(chat, assignee);
  });

  saveChatState(state);
  return state;
}

async function assignUnassignedChatsToOnlineSpecialists() {
  const state = getChatState();
  const unassignedChats = getActiveChats(state).filter((chat) => !chat.assignedUserId);

  for (const chat of unassignedChats) {
    const assignee = pickBalancedAssignee(state, chat.telegramChatId || chat.id, chat.id);
    assignChatRecord(chat, assignee);
    await sendGreetingForAssignedChat(chat);
  }

  saveChatState(state);
  return state;
}

function getOnlineSpecialistWorkload() {
  const state = getChatState();
  return getOnlineSpecialists().map((user) => ({
    ...user,
    activeChats: countActiveChatsForUser(state, user.id)
  }));
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((acc, entry) => {
      const [key, ...rest] = entry.split('=');
      acc[key] = decodeURIComponent(rest.join('=') || '');
      return acc;
    }, {});
}

function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId || !sessions.has(sessionId)) {
    return null;
  }

  const session = sessions.get(sessionId);
  const users = getUserState().users;
  const user = users.find((entry) => entry.id === session.userId);
  if (!user) {
    sessions.delete(sessionId);
    return null;
  }

  return sanitizeUser(user);
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Потрібно увійти в систему.' });
  }
  req.sessionUser = user;
  return next();
}

function requireAdmin(req, res, next) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Потрібно увійти в систему.' });
  }
  if (user.role !== 'administrator') {
    return res.status(403).json({ ok: false, error: 'Недостатньо прав доступу.' });
  }
  req.sessionUser = user;
  return next();
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
  const chats = Array.isArray(state.chats) ? state.chats : [];
  return {
    chats: chats.map((chat) => ({
      ...chat,
      telegramChatId: String(chat.telegramChatId || chat.id),
      threadStatus: chat.threadStatus === 'completed' ? 'completed' : 'active',
      messages: Array.isArray(chat.messages) ? chat.messages : []
    }))
  };
}

function saveChatState(nextState) {
  writeJson(CHATS_PATH, nextState);
  return nextState;
}

function createChatRecord({ id, telegramChatId, name, initials, username = '', source = 'Telegram', assignedUserId = '', assignedUserName = '' }) {
  return {
    id,
    telegramChatId: String(telegramChatId || id),
    name,
    initials,
    username,
    source,
    assignedUserId,
    assignedUserName,
    unread: 0,
    threadStatus: 'active',
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    greetingSentAt: '',
    closedAt: '',
    closedByUserId: '',
    closedByUserName: '',
    messages: []
  };
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

function buildClosingMessage(date = new Date()) {
  const settings = getSettings();
  return renderMessageTemplate(settings.closingTemplate || defaultSettings.closingTemplate, {
    timeOfDay: getTimeOfDayWord(date)
  });
}

function getTimeOfDayWord(date = new Date()) {
  const hour = date.getHours();
  return hour >= 6 && hour < 18 ? 'дня' : 'вечора';
}

function renderMessageTemplate(template, context = {}) {
  return String(template || '')
    .replace(/\{specialistName\}/g, String(context.specialistName || 'спеціаліст'))
    .replace(/\{timeOfDay\}/g, String(context.timeOfDay || getTimeOfDayWord(new Date())))
    .trim();
}

function buildGreetingMessage(specialistName) {
  const settings = getSettings();
  return renderMessageTemplate(settings.greetingTemplate || defaultSettings.greetingTemplate, {
    specialistName
  });
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
    telegramChatId: chatRecord.telegramChatId || chatRecord.id,
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
    assignedUserId: chatRecord.assignedUserId || '',
    assignedUserName: chatRecord.assignedUserName || '',
    threadStatus: chatRecord.threadStatus || 'active',
    closedAt: chatRecord.closedAt || '',
    closedByUserName: chatRecord.closedByUserName || '',
    subtitle: `Telegram ID: ${chatRecord.telegramChatId || chatRecord.id} • ${chatRecord.username ? `@${chatRecord.username} • ` : ''}Канал: Telegram Bot`,
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

function getDashboardPayload(sessionUser) {
  const state = getChatState();
  const sortedChats = state.chats
    .slice()
    .sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt));
  const activeChats = sortedChats.filter((chat) => (chat.threadStatus || 'active') !== 'completed');

  const visibleSourceChats = sessionUser?.role === 'administrator'
    ? activeChats
    : activeChats.filter((chat) => chat.assignedUserId === sessionUser?.id);

  const chats = visibleSourceChats.map(toDashboardChat);

  return {
    sessionUser,
    settings: sanitizeSettings(getSettings()),
    chats,
    summary: {
      totalChats: activeChats.length,
      archivedChats: Math.max(0, sortedChats.length - activeChats.length),
      visibleChats: chats.length
    }
  };
}

function sanitizeSettings(settings) {
  return {
    hasBotToken: Boolean(settings.botToken),
    publicWebhookUrl: settings.publicWebhookUrl || '',
    webhookPath: settings.webhookPath || defaultSettings.webhookPath,
    assignmentStrategy: settings.assignmentStrategy || defaultSettings.assignmentStrategy,
    greetingTemplate: settings.greetingTemplate || defaultSettings.greetingTemplate,
    closingTemplate: settings.closingTemplate || defaultSettings.closingTemplate,
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
    await persistIncomingMessage(ctx.update.message);
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

async function persistIncomingMessage(message) {
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

  let chat = state.chats.find((entry) =>
    String(entry.telegramChatId || entry.id) === chatId && (entry.threadStatus || 'active') !== 'completed'
  );
  let shouldSendGreeting = false;
  if (!chat) {
    const latestClosedThread = state.chats
      .filter((entry) => String(entry.telegramChatId || entry.id) === chatId)
      .sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt))[0];
    const nextId = latestClosedThread ? `${chatId}-${Date.now()}` : chatId;
    chat = createChatRecord({
      id: nextId,
      telegramChatId: chatId,
      name: fullName,
      initials: initialsFromName(fullName),
      username: message.from?.username || '',
      source: 'Telegram',
      assignedUserId: '',
      assignedUserName: ''
    });
    applyAutomaticAssignment(state, chat);
    state.chats.push(chat);
    shouldSendGreeting = Boolean(chat.assignedUserId && !chat.greetingSentAt);
  } else if (!chat.assignedUserId) {
    applyAutomaticAssignment(state, chat);
    shouldSendGreeting = Boolean(chat.assignedUserId && !chat.greetingSentAt);
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

  if (shouldSendGreeting) {
    await sendGreetingForAssignedChat(chat);
  }

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

app.get('/api/auth/session', (req, res) => {
  const user = getSessionUser(req);
  res.json({ ok: true, authenticated: Boolean(user), user });
});

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const users = getUserState().users;
  const user = users.find((entry) => entry.username === username);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ ok: false, error: 'Невірний логін або пароль.' });
  }

  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { userId: user.id, createdAt: new Date().toISOString() });
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 12}`);
  return res.json({ ok: true, user: sanitizeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  return res.json({ ok: true });
});

app.post('/api/users/me/status', requireAuth, async (req, res) => {
  const userState = getUserState();
  const user = userState.users.find((entry) => entry.id === req.sessionUser.id);
  if (!user) {
    return res.status(404).json({ ok: false, error: 'Користувача не знайдено.' });
  }

  user.availabilityStatus = normalizeAvailabilityStatus(String(req.body.status || '').trim().toLowerCase());
  saveUserState(userState);
  if (user.availabilityStatus === 'break' || user.availabilityStatus === 'offline') {
    rebalanceChatsForUnavailableUser(user.id);
  }
  if (user.availabilityStatus === 'online') {
    await assignUnassignedChatsToOnlineSpecialists();
  }
  return res.json({ ok: true, user: sanitizeUser(user) });
});

app.post('/api/admin/distribution', requireAdmin, (req, res) => {
  const current = getSettings();
  const assignmentStrategy = req.body.assignmentStrategy === 'load-balanced-priority'
    ? 'load-balanced-priority'
    : defaultSettings.assignmentStrategy;

  const nextSettings = {
    ...current,
    assignmentStrategy
  };
  saveSettings(nextSettings);
  return res.json({ ok: true, settings: sanitizeSettings(nextSettings) });
});

app.post('/api/admin/message-templates', requireAdmin, (req, res) => {
  const current = getSettings();
  const nextSettings = {
    ...current,
    greetingTemplate: String(req.body.greetingTemplate || defaultSettings.greetingTemplate).trim() || defaultSettings.greetingTemplate,
    closingTemplate: String(req.body.closingTemplate || defaultSettings.closingTemplate).trim() || defaultSettings.closingTemplate
  };
  saveSettings(nextSettings);
  return res.json({ ok: true, settings: sanitizeSettings(nextSettings) });
});

app.get('/suphub', (req, res) => {
  res.sendFile(path.join(__dirname, 'suphub_dashboard.html'));
});

app.get('/forecast', (req, res) => {
  res.sendFile(path.join(__dirname, 'forecast_dashboard.html'));
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  res.json(getDashboardPayload(req.sessionUser));
});

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(sanitizeSettings(getSettings()));
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ ok: true, users: getUserState().users.map(sanitizeUser) });
});

app.get('/api/admin/workload', requireAdmin, (req, res) => {
  res.json({ ok: true, users: getOnlineSpecialistWorkload() });
});

app.get('/api/users/assignable', requireAuth, (req, res) => {
  res.json({ ok: true, users: getOnlineAssignableUsers() });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const userState = getUserState();
  const username = String(req.body.username || '').trim().toLowerCase();
  const fullName = String(req.body.fullName || '').trim();
  const password = String(req.body.password || '').trim();
  const role = req.body.role === 'administrator' ? 'administrator' : 'specialist';

  if (!username || !fullName || !password) {
    return res.status(400).json({ ok: false, error: 'Потрібні username, fullName та password.' });
  }

  if (userState.users.some((entry) => entry.username === username)) {
    return res.status(400).json({ ok: false, error: 'Користувач з таким логіном уже існує.' });
  }

  const newUser = createStoredUser({ username, fullName, role, password });
  userState.users.push(newUser);
  saveUserState(userState);
  return res.json({ ok: true, user: sanitizeUser(newUser) });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const userState = getUserState();
  const user = userState.users.find((entry) => entry.id === req.params.id);
  if (!user) {
    return res.status(404).json({ ok: false, error: 'Користувача не знайдено.' });
  }

  if (req.body.fullName) {
    user.fullName = String(req.body.fullName).trim();
  }
  if (req.body.role === 'administrator' || req.body.role === 'specialist') {
    user.role = req.body.role;
  }
  if (req.body.password) {
    user.passwordHash = createPasswordHash(String(req.body.password).trim());
  }

  saveUserState(userState);
  return res.json({ ok: true, user: sanitizeUser(user) });
});

app.get('/api/admin/specialists', requireAuth, (req, res) => {
  res.json({ ok: true, users: getSpecialistUsers() });
});

app.post('/api/admin/chats/:id/assign', requireAuth, (req, res) => {
  const state = getChatState();
  const chat = state.chats.find((entry) => entry.id === String(req.params.id));
  if (!chat) {
    return res.status(404).json({ ok: false, error: 'Чат не знайдено.' });
  }

  if (!req.sessionUser || (req.sessionUser.role !== 'administrator' && req.sessionUser.role !== 'specialist')) {
    return res.status(403).json({ ok: false, error: 'Недостатньо прав доступу.' });
  }

  const targetUserId = String(req.body.userId || '').trim();
  if (!targetUserId) {
    chat.assignedUserId = '';
    chat.assignedUserName = '';
    saveChatState(state);
    return res.json({ ok: true, chatId: chat.id, assignedUserId: '', assignedUserName: '' });
  }

  const targetUser = getUserState().users.find((user) =>
    user.id === targetUserId && (user.role === 'specialist' || user.role === 'administrator')
  );
  if (!targetUser) {
    return res.status(400).json({ ok: false, error: 'Можна передати чат лише на адміністратора або спеціаліста.' });
  }

  if (normalizeAvailabilityStatus(targetUser.availabilityStatus) !== 'online') {
    return res.status(400).json({ ok: false, error: 'Можна призначати нові чати лише співробітникам зі статусом Online.' });
  }

  chat.assignedUserId = targetUser.id;
  chat.assignedUserName = targetUser.fullName;
  saveChatState(state);

  return res.json({
    ok: true,
    chatId: chat.id,
    assignedUserId: targetUser.id,
    assignedUserName: targetUser.fullName
  });
});

app.get('/api/chats/:id/history', requireAuth, (req, res) => {
  const state = getChatState();
  const currentChat = state.chats.find((entry) => entry.id === String(req.params.id));
  if (!currentChat) {
    return res.status(404).json({ ok: false, error: 'Чат не знайдено.' });
  }

  const history = state.chats
    .filter((entry) =>
      entry.id !== currentChat.id &&
      String(entry.telegramChatId || entry.id) === String(currentChat.telegramChatId || currentChat.id) &&
      (entry.threadStatus || 'active') === 'completed'
    )
    .sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt))
    .map((entry) => ({
      id: entry.id,
      assignedUserName: entry.assignedUserName || '',
      closedByUserName: entry.closedByUserName || '',
      closedAt: entry.closedAt || '',
      createdAt: entry.createdAt || '',
      lastActivityAt: entry.lastActivityAt,
      messages: (entry.messages || []).map((message) => ({
        side: message.side,
        author: message.author,
        text: message.text,
        media: message.media || null,
        time: new Date(message.timestamp).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
        timestamp: message.timestamp
      }))
    }));

  return res.json({ ok: true, history });
});

app.post('/api/chats/:id/complete', requireAuth, async (req, res) => {
  const state = getChatState();
  const chat = state.chats.find((entry) => entry.id === String(req.params.id));
  if (!chat) {
    return res.status(404).json({ ok: false, error: 'Чат не знайдено.' });
  }

  if ((chat.threadStatus || 'active') === 'completed') {
    return res.status(400).json({ ok: false, error: 'Чат уже завершено.' });
  }

  const closingMessage = buildClosingMessage(new Date());
  const timestamp = new Date().toISOString();

  try {
    const liveBot = getBot();
    if (liveBot) {
      await liveBot.telegram.sendMessage(chat.telegramChatId || chat.id, closingMessage);
    }
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Не вдалося завершити чат у Telegram: ${error.message}` });
  }

  chat.unread = 0;
  chat.lastActivityAt = timestamp;
  chat.threadStatus = 'completed';
  chat.closedAt = timestamp;
  chat.closedByUserId = req.sessionUser.id;
  chat.closedByUserName = req.sessionUser.fullName;
  chat.messages.push({
    id: `close-${Date.now()}`,
    side: 'out',
    author: req.sessionUser.fullName || 'Спеціаліст',
    text: closingMessage,
    media: null,
    timestamp
  });
  saveChatState(state);

  return res.json({ ok: true, chatId: chat.id, closedAt: chat.closedAt });
});

app.post('/api/admin/settings', requireAdmin, async (req, res) => {
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

app.post('/api/admin/webhook/register', requireAdmin, async (req, res) => {
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

app.post('/api/admin/messages/outgoing', requireAuth, async (req, res) => {
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
      await liveBot.telegram.sendMessage(chat.telegramChatId || chat.id, String(text).trim());
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

app.get('/api/telegram/file/:fileId', requireAuth, async (req, res) => {
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
