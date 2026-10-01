import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateInspectionPhoto, formatInspectionCaption } from './inspection-photo.js';
import { validateGo1Notice, formatGo1Message } from '../src/go1-reports.js';

export function parseEnvFile(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const end = value.lastIndexOf(value[0]);
      value = end > 0 ? value.slice(1, end) : value;
    } else value = value.replace(/\s+#.*$/, '').trim();
    result[match[1]] = value;
  }
  return result;
}

async function envFile(file) {
  try { return parseEnvFile(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw Error('텔레그램 설정 파일을 읽지 못했습니다. 파일 접근 권한을 확인하세요.'); }
}

export async function readTelegramConfig(root, env = process.env) {
  const local = { ...await envFile(path.join(root, '.env')), ...await envFile(path.join(root, '.env.local')), ...env };
  const explicitToken = local.TWIN_TELEGRAM_BOT_TOKEN;
  const explicitChat = local.TWIN_TELEGRAM_CHAT_ID;
  let token, chatId, threadId, source, allowedUsers;
  if (explicitToken || explicitChat) {
    token = explicitToken; chatId = explicitChat; threadId = local.TWIN_TELEGRAM_THREAD_ID;
    source = '프로젝트 설정';
    allowedUsers = local.TWIN_TELEGRAM_ALLOWED_USERS;
  } else {
    const hermesHome = env.HERMES_HOME || (process.platform === 'win32' && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'hermes') : path.join(os.homedir(), '.hermes'));
    const hermes = { ...await envFile(path.join(hermesHome, '.env')), ...env };
    token = hermes.TELEGRAM_BOT_TOKEN; chatId = hermes.TELEGRAM_HOME_CHANNEL; threadId = hermes.TELEGRAM_HOME_CHANNEL_THREAD_ID;
    source = 'Hermes 기본 대화방';
    allowedUsers = hermes.TELEGRAM_ALLOWED_USERS;
  }
  if (!token || !chatId) return { configured: false, source, error: 'Hermes 기본 대화방 또는 프로젝트의 텔레그램 봇·대화방 설정을 확인하세요.' };
  if (!/^\d{5,16}:[A-Za-z0-9_-]{20,}$/.test(token) || !/^-?\d{1,20}$/.test(chatId) || threadId && !/^[1-9]\d{0,12}$/.test(threadId)) {
    return { configured: false, source, error: '텔레그램 봇 토큰, 대화방 ID 또는 토픽 ID 형식이 올바르지 않습니다.' };
  }
  return { configured: true, token, chatId, threadId: threadId ? Number(threadId) : undefined, source, allowedUsers: (allowedUsers || '').split(/[,;\s]+/).filter(id => /^\d+$/.test(id)) };
}

export async function telegramApi(config, method, payload = {}) {
  let response, result;
  try {
    let body, headers;
    if (method === 'sendPhoto') {
      body = new FormData();
      for (const key of ['chat_id', 'caption', 'message_thread_id']) if (payload[key] !== undefined) body.append(key, String(payload[key]));
      body.append('photo', new Blob([payload.photo], { type: 'image/jpeg' }), payload.filename);
    } else { headers = { 'Content-Type': 'application/json' }; body = JSON.stringify(payload); }
    response = await fetch('https://api.telegram.org/bot' + config.token + '/' + method, {
      method: 'POST', headers, body,
      signal: AbortSignal.timeout(12000), redirect: 'error',
    });
    result = await response.json();
  } catch {
    throw Object.assign(Error(['sendMessage', 'sendPhoto'].includes(method) ? '전송 결과를 확인하지 못했습니다. 텔레그램 대화방을 확인하세요. 자동으로 재전송하지 않습니다.' : '텔레그램에 연결하지 못했습니다. 인터넷 연결을 확인하세요.'), { code: 'TELEGRAM_UNCONFIRMED' });
  }
  if (!response.ok || !result.ok) {
    const code = Number(result.error_code || response.status);
    const messages = { 400: '대화방 또는 토픽을 찾지 못했습니다. 봇과 먼저 대화하고 대화방 설정을 확인하세요.', 401: '텔레그램 봇 토큰이 유효하지 않습니다.', 403: '이 봇이 해당 대화방으로 메시지를 보낼 수 없습니다. 봇 차단과 대화방 권한을 확인하세요.', 429: '텔레그램 전송 제한에 도달했습니다. 잠시 후 다시 보내세요.' };
    throw Object.assign(Error(messages[code] || '텔레그램 요청이 실패했습니다. 대화방 연결을 확인하세요.'), { code: 'TELEGRAM_' + code });
  }
  return result.result;
}

export function createTelegramService({ root, configReader = () => readTelegramConfig(root), api = telegramApi, intervalMs = 3200, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const configPromise = Promise.resolve().then(configReader).catch(() => ({ configured: false, error: '텔레그램 설정 파일을 읽지 못했습니다. 파일 접근 권한을 확인하세요.' }));
  const deliveries = new Map();
  let metadata = null, metadataPending = null, queue = Promise.resolve(), lastAttempt = null, lastSentAt = null, sentCount = 0, lastError = null;
  async function status({ refresh = false } = {}) {
    const config = await configPromise;
    if (!config.configured) return { configured: false, connected: false, source: config.source, error: config.error, sentCount, lastSentAt };
    if (refresh) metadata = null;
    if (!metadata) {
      metadataPending ||= Promise.all([api(config, 'getMe'), api(config, 'getChat', { chat_id: config.chatId })])
        .then(([bot, chat]) => {
          if (!bot.is_bot || String(chat.id) !== config.chatId) throw Error('설정한 텔레그램 대화방을 확인하지 못했습니다.');
          return metadata = { botUsername: bot.username || '', chatTitle: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || '기본 대화방', chatType: chat.type, recipient: '…' + config.chatId.slice(-4) };
        }).finally(() => { metadataPending = null; });
      try { await metadataPending; }
      catch (error) { return { configured: true, connected: false, source: config.source, error: error.message, sentCount, lastSentAt }; }
    }
    return { configured: true, connected: true, source: config.source, ...metadata, sentCount, lastSentAt, lastError };
  }
  function deliver(input, text, fingerprint, photo = null) {
    if (deliveries.has(input.id)) {
      const existing = deliveries.get(input.id);
      if (existing.fingerprint !== fingerprint) throw Error('같은 전송 ID의 보고 내용을 변경할 수 없습니다.');
      return existing.promise;
    }
    if ([...deliveries.values()].filter(d => !d.settled).length >= 20) throw Error('전송 대기 중인 보고가 많습니다. 잠시 후 다시 보내세요.');
    for (const [id, d] of deliveries) if (deliveries.size >= 300 && d.settled) deliveries.delete(id);
    const entry = { fingerprint, settled: false, promise: null };
    entry.promise = queue.catch(() => {}).then(async () => {
      const config = await configPromise;
      if (!config.configured) throw Error(config.error);
      const connected = await status();
      if (!connected.connected) throw Error(connected.error);
      const wait = lastAttempt === null ? 0 : Math.max(0, intervalMs - (now() - lastAttempt));
      if (wait) await delay(wait);
      lastAttempt = now();
      const payload = photo ? { chat_id: config.chatId, caption: text, photo: photo.bytes, filename: 'Go1-' + input.snapshot.targetId + '-' + input.snapshot.runId + '.jpg' }
        : { chat_id: config.chatId, text, link_preview_options: { is_disabled: true } };
      if (config.threadId) payload.message_thread_id = config.threadId;
      const message = await api(config, photo ? 'sendPhoto' : 'sendMessage', payload);
      if (!Number.isInteger(message.message_id) || String(message.chat?.id) !== config.chatId) throw Error('텔레그램 전송 응답을 확인하지 못했습니다. 대화방을 확인하세요.');
      if (photo && (!Array.isArray(message.photo) || !message.photo.some(p => p.width > 0 && p.height > 0 && typeof p.file_id === 'string'))) throw Error('텔레그램 사진 수신 응답을 확인하지 못했습니다. 대화방을 확인하세요. 자동으로 재전송하지 않습니다.');
      sentCount++; lastSentAt = new Date(now()).toISOString(); lastError = null;
      return { id: input.id, delivered: true, messageId: message.message_id, sentAt: lastSentAt, runId: input.snapshot?.runId || null, kind: input.kind };
    }).catch(error => { lastError = error.message; throw error; }).finally(() => { entry.settled = true; });
    queue = entry.promise;
    // HTTP callers can disconnect while an already queued delivery is finishing.
    queue.catch(() => {});
    deliveries.set(input.id, entry);
    return entry.promise;
  }
  function send(raw) {
    const input = validateGo1Notice(raw);
    return deliver(input, formatGo1Message(input), JSON.stringify(input));
  }
  function notify(id, text) {
    if (!/^[A-Za-z0-9:-]{8,100}$/.test(id) || typeof text !== 'string' || !text || text.length > 4000) throw Error('Go1 명령 안내가 올바르지 않습니다.');
    const input = { id, kind: 'command' };
    return deliver(input, text, JSON.stringify({ ...input, text }));
  }
  function sendPhoto(raw) {
    const input = validateInspectionPhoto(raw);
    return deliver(input, formatInspectionCaption(input), input.fingerprint, input.image);
  }
  async function authorizeRemote({ chatId, userId, threadId }) {
    const config = await configPromise;
    return Boolean(config.configured && String(chatId) === config.chatId && /^\d+$/.test(String(userId))
      && (config.chatId[0] !== '-' ? String(userId) === config.chatId : config.allowedUsers?.includes(String(userId)))
      && String(threadId || '') === String(config.threadId || ''));
  }
  return { status, send, sendPhoto, notify, authorizeRemote, counters: () => ({ sentCount, lastError }) };
}
