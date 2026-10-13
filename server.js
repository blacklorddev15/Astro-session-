require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const SESSION_PREFIX = process.env.SESSION_PREFIX || 'ASTRO X:~';
const MAX_ACTIVE_TOTAL = Number(process.env.MAX_ACTIVE_SESSIONS || 2);
const MAX_ACTIVE_PER_IP = Number(process.env.MAX_ACTIVE_PER_IP || 1);
const MAX_REQUESTS_PER_HOUR = Number(process.env.MAX_REQUESTS_PER_HOUR || 5);
const MAX_GLOBAL_REQUESTS_PER_HOUR = Number(process.env.MAX_GLOBAL_REQUESTS_PER_HOUR || 30);
const MAX_RETAINED_SESSIONS = Number(process.env.MAX_RETAINED_SESSIONS || 128);
const MAX_RATE_LIMIT_KEYS = Number(process.env.MAX_RATE_LIMIT_KEYS || 4096);
const PHONE_COOLDOWN_MS = Number(process.env.PHONE_COOLDOWN_MS || 5 * 60 * 1000);
const PAIRING_TIMEOUT_MS = Number(process.env.PAIRING_TIMEOUT_MS || 10 * 60 * 1000);
const RESULT_RETENTION_MS = Number(process.env.RESULT_RETENTION_MS || 10 * 60 * 1000);
const MAX_ATTEMPTS = 3;
const TEMP_PARENT = path.join(os.tmpdir(), 'astro-x-ultra-web-sessions');
const TEMP_ROOT = path.join(TEMP_PARENT, `${process.pid}-${crypto.randomBytes(6).toString('hex')}`);

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(express.json({ limit: '2kb', strict: true }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});
// The site files live in "Public" (capital P) in this repository. Linux filesystems are
// case-sensitive, so the previous lowercase path resolved to a directory that does not
// exist, express.static served nothing, and Express answered "/" with its default
// "Cannot GET /" 404. Keep this casing in sync with the directory on GitHub.
app.use(express.static(path.join(__dirname, 'Public'), {
  index: 'index.html',
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

const sessions = new Map();
const activeByIp = new Map();
const requestWindows = new Map();
const phoneCooldowns = new Map();
const clientTokenIndex = new Map();
const phoneHashSalt = crypto.randomBytes(32);
const limiterWindowMs = 60 * 60 * 1000;
let globalRequestWindow = { startedAt: Date.now(), count: 0 };
let shuttingDown = false;

function randomId() {
  return crypto.randomBytes(32).toString('base64url');
}

function hasValidAccessToken(req, entry) {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.get('authorization') || '');
  if (!match || !entry.accessToken) return false;
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(entry.accessToken);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function clientIp(req) {
  return String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 96);
}

function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get('host')) {
      return res.status(403).json({ error: 'Cross-origin requests are not accepted.' });
    }
  } catch (_) {
    return res.status(403).json({ error: 'Invalid request origin.' });
  }
  next();
}

function clearExpiry(entry) {
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  entry.expiryTimer = null;
}

function trackAuthWrite(entry, operation) {
  const pending = Promise.resolve().then(operation);
  entry.pendingAuthWrites.add(pending);
  pending.catch(error => {
    entry.authWriteError = error;
    console.error('Credential storage operation failed:', error.name || 'Error');
  });
  pending.then(
    () => entry.pendingAuthWrites.delete(pending),
    () => entry.pendingAuthWrites.delete(pending)
  );
  return pending;
}

async function waitForAuthWrites(entry) {
  while (entry.pendingAuthWrites.size) {
    await Promise.allSettled(Array.from(entry.pendingAuthWrites));
  }
}

function releaseActive(entry) {
  if (activeByIp.get(entry.ip)?.has(entry.id)) {
    const ids = activeByIp.get(entry.ip);
    ids.delete(entry.id);
    if (!ids.size) activeByIp.delete(entry.ip);
  }
}

async function closeSocket(entry) {
  const sock = entry.sock;
  entry.sock = null;
  if (sock) {
    try { if (sock.ws) sock.ws.close(); } catch (_) {}
    try { if (sock.end) await sock.end(); } catch (_) {}
    const listeners = entry.socketListeners;
    if (listeners?.sock === sock) {
      try { sock.ev.off('creds.update', listeners.creds); } catch (_) {}
      try { sock.ev.off('connection.update', listeners.connection); } catch (_) {}
      entry.socketListeners = null;
    }
  }
  await waitForAuthWrites(entry);
}

async function removeTempCredentials(entry) {
  try { fs.rmSync(entry.sessionDir, { recursive: true, force: true }); } catch (_) {}
}

async function cleanupSocketAndCredentials(entry) {
  await closeSocket(entry);
  await removeTempCredentials(entry);
}

function prepareTempRoot() {
  fs.mkdirSync(TEMP_PARENT, { recursive: true, mode: 0o700 });
  const staleBefore = Date.now() - 60 * 60 * 1000;
  for (const name of fs.readdirSync(TEMP_PARENT)) {
    const candidate = path.join(TEMP_PARENT, name);
    try {
      const info = fs.statSync(candidate);
      if (info.isDirectory() && info.mtimeMs < staleBefore) {
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    } catch (_) {}
  }
  fs.mkdirSync(TEMP_ROOT, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(TEMP_ROOT, 0o700); } catch (_) {}
}

function scheduleResultDeletion(entry, milliseconds = RESULT_RETENTION_MS) {
  clearExpiry(entry);
  entry.expiresAt = Date.now() + milliseconds;
  entry.expiryTimer = setTimeout(() => {
    expireEntry(entry).catch(() => {});
  }, milliseconds);
  entry.expiryTimer.unref?.();
}

async function expireEntry(entry) {
  clearExpiry(entry);
  await cleanupSocketAndCredentials(entry);
  releaseActive(entry);
  sessions.delete(entry.id);
  if (entry.clientTokenKey) clientTokenIndex.delete(entry.clientTokenKey);
  // SESSION_ID and phone number are erased when the entry is removed.
  entry.sessionId = null;
  entry.phoneNumber = null;
  entry.accessToken = null;
}

function failEntry(entry, safeMessage, logError) {
  if (entry.finished || entry.cancelled) return;
  entry.finished = true;
  entry.status = 'failed';
  entry.message = safeMessage;
  // Log the message too, not just the name. The name alone ("TypeError") is not enough to
  // tell apart a bad option from a socket problem, and it cost a lot of guessing to find
  // one. Capped and never containing a phone number, code or credential.
  if (logError) console.error('Pairing request failed:', logError.name || 'Error', '-', String(logError.message || '').slice(0, 200));
  entry.phoneNumber = null;
  releaseActive(entry);
  cleanupSocketAndCredentials(entry).catch(() => {});
  scheduleResultDeletion(entry, RESULT_RETENTION_MS);
}

async function issuePairingCode(entry, phoneNumber) {
  if (shuttingDown || entry.finished || entry.cancelled || sessions.get(entry.id) !== entry) return;
  entry.attempts += 1;
  entry.status = 'starting';
  entry.pairingCode = null;
  entry.message = 'Connecting securely to WhatsApp…';

  let sock;
  try {
    fs.mkdirSync(entry.sessionDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(entry.sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    if (entry.finished || entry.cancelled || sessions.get(entry.id) !== entry) return;
    const originalKeySet = state.keys.set.bind(state.keys);
    state.keys.set = data => trackAuthWrite(entry, () => originalKeySet(data));

    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          pino({ level: 'silent' }).child({ level: 'silent' })
        )
      },
      version,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['ASTRO X ULTRA', 'Chrome', '120.0.0.0'],
      // Baileys 7 calls this as a callback while building the socket, so passing a
      // boolean `false` made makeWASocket throw
      // "config.shouldSyncHistoryMessage is not a function" on every attempt — which the
      // UI surfaced only as "The pairing service could not start." Returning false keeps
      // the original intent (never sync chat history) and satisfies the callback API.
      shouldSyncHistoryMessage: () => false,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });
    entry.sock = sock;
    const credsListener = () => trackAuthWrite(entry, saveCreds).catch(() => {});

    const connectionListener = async update => {
      if (entry.sock !== sock || entry.finished || entry.cancelled) return;
      if (update.connection === 'open') {
        if (entry.finalizing) return;
        entry.finalizing = true;
        try {
          await delay(1000);
          if (entry.sock !== sock || entry.finished || entry.cancelled || sessions.get(entry.id) !== entry) return;
          await waitForAuthWrites(entry);
          if (entry.sock !== sock || entry.finished || entry.cancelled || sessions.get(entry.id) !== entry) return;
          if (entry.authWriteError) throw entry.authWriteError;
          await trackAuthWrite(entry, saveCreds);
          if (entry.sock !== sock || entry.finished || entry.cancelled || sessions.get(entry.id) !== entry) return;
          const serialized = JSON.stringify(state.creds);
          if (!serialized) throw new Error('Credentials were empty.');
          // No await between the last liveness check and publishing the session,
          // so cancellation cannot interleave with this state transition.
          const sessionId = SESSION_PREFIX + Buffer.from(serialized, 'utf8').toString('base64');
          const selfJid = state.creds.me?.id
            ? jidNormalizedUser(state.creds.me.id)
            : `${phoneNumber}@s.whatsapp.net`;
          if (!selfJid || !selfJid.endsWith('@s.whatsapp.net')) {
            throw new Error('The linked account self-chat could not be identified.');
          }
          await sock.sendMessage(selfJid, {
            text: `ASTRO X ULTRA SESSION_ID\n\n${sessionId}\n\nKeep this value private. It can provide access to your linked WhatsApp account.`
          });
          if (entry.sock !== sock || entry.cancelled || sessions.get(entry.id) !== entry) return;
          entry.sessionId = null;
          entry.status = 'complete';
          entry.message = 'WhatsApp linked. Your SESSION_ID was sent to your WhatsApp self-chat.';
          entry.finished = true;
          entry.phoneNumber = null;
          releaseActive(entry);
          await closeSocket(entry);
          if (entry.cancelled || entry.status !== 'complete') {
            entry.sessionId = null;
            return;
          }
          await removeTempCredentials(entry);
          scheduleResultDeletion(entry);
        } catch (error) {
          if (!entry.cancelled && !entry.finished) {
            failEntry(entry, 'WhatsApp linked, but delivery to your WhatsApp self-chat failed. The SESSION_ID was not displayed on this website. Check your self-chat and try again.', error);
          }
        } finally {
          entry.finalizing = false;
        }
        return;
      }

      if (update.connection !== 'close' || entry.retrying || entry.finalizing) return;
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      if (!loggedOut && entry.attempts < MAX_ATTEMPTS) {
        entry.retrying = true;
        entry.pairingCode = null;
        entry.status = 'starting';
        entry.message = 'Reconnecting to WhatsApp…';
        await closeSocket(entry);
        await delay(2500);
        entry.retrying = false;
        if (!entry.finished && !entry.cancelled) await issuePairingCode(entry, phoneNumber);
      } else {
        failEntry(
          entry,
          loggedOut
            ? 'WhatsApp rejected or closed the pairing attempt. Start a new request.'
            : 'Could not connect to WhatsApp after several attempts. Start a new request.',
          null
        );
      }
    };
    entry.socketListeners = { sock, creds: credsListener, connection: connectionListener };
    sock.ev.on('creds.update', credsListener);
    sock.ev.on('connection.update', connectionListener);

    if (!state.creds.registered) {
      await delay(1000);
      if (entry.sock !== sock || entry.cancelled || entry.finished) return;
      const code = await sock.requestPairingCode(phoneNumber);
      if (entry.sock !== sock || entry.cancelled || entry.finished) return;
      entry.pairingCode = String(code).length === 8
        ? `${String(code).slice(0, 4)}-${String(code).slice(4)}`
        : String(code);
      entry.status = 'code_ready';
      entry.message = 'Enter this code in WhatsApp → Linked Devices → Link with phone number.';
    }
  } catch (error) {
    if (sock && entry.sock !== sock) return;
    if (!entry.finished && !entry.cancelled && entry.attempts < MAX_ATTEMPTS) {
      entry.retrying = true;
      entry.pairingCode = null;
      entry.status = 'starting';
      entry.message = 'Retrying the WhatsApp connection…';
      await cleanupSocketAndCredentials(entry);
      await delay(1000 * entry.attempts);
      entry.retrying = false;
      if (!entry.finished && !entry.cancelled && sessions.get(entry.id) === entry) {
        await issuePairingCode(entry, phoneNumber);
      }
      return;
    }
    failEntry(entry, 'The pairing service could not start. Please try again later.', error);
  }
}

function currentRateWindow(ip) {
  const now = Date.now();
  let record = requestWindows.get(ip);
  if (!record || now - record.startedAt >= limiterWindowMs) {
    if (!record && requestWindows.size >= MAX_RATE_LIMIT_KEYS) {
      const firstKey = requestWindows.keys().next().value;
      if (firstKey !== undefined) requestWindows.delete(firstKey);
    }
    record = { startedAt: now, count: 0 };
    requestWindows.set(ip, record);
  }
  return record;
}

function phoneCooldownKey(phoneNumber) {
  return crypto.createHmac('sha256', phoneHashSalt).update(phoneNumber).digest('hex');
}

function validClientToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  try { return Buffer.from(token, 'base64url').length === 32; } catch (_) { return false; }
}

function clientTokenKey(token) {
  return crypto.createHmac('sha256', phoneHashSalt).update(`client:${token}`).digest('hex');
}

function reserveSessionCapacity() {
  if (sessions.size < MAX_RETAINED_SESSIONS) return true;
  const terminal = Array.from(sessions.values())
    .filter(entry => entry.finished || entry.cancelled)
    .sort((a, b) => a.expiresAt - b.expiresAt);
  for (const entry of terminal) {
    clearExpiry(entry);
    entry.sessionId = null;
    entry.phoneNumber = null;
    entry.accessToken = null;
    if (entry.clientTokenKey) clientTokenIndex.delete(entry.clientTokenKey);
    releaseActive(entry);
    sessions.delete(entry.id);
    if (sessions.size < MAX_RETAINED_SESSIONS) return true;
  }
  return sessions.size < MAX_RETAINED_SESSIONS;
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/sessions', sameOrigin, async (req, res) => {
  if (shuttingDown) return res.status(503).json({ error: 'The service is restarting. Try again shortly.' });
  const clientToken = req.body?.clientToken;
  if (!validClientToken(clientToken)) {
    return res.status(400).json({ error: 'Could not create a secure request. Refresh the page and try again.' });
  }
  const ip = clientIp(req);
  const tokenKey = clientTokenKey(clientToken);
  const existingId = clientTokenIndex.get(tokenKey);
  if (existingId) {
    const existing = sessions.get(existingId);
    if (existing && existing.ip === ip && existing.accessToken === clientToken) {
      return res.status(202).json({ requestId: existing.id, status: existing.status, expiresInSeconds: Math.max(0, Math.floor((existing.expiresAt - Date.now()) / 1000)) });
    }
    clientTokenIndex.delete(tokenKey);
  }
  const rawNumber = typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber : '';
  if (!rawNumber) return res.status(404).json({ error: 'No active request was found. Enter your number to start again.' });
  const phoneNumber = rawNumber.replace(/\D/g, '');
  if (phoneNumber.length < 7 || phoneNumber.length > 15) {
    return res.status(400).json({ error: 'Enter a valid phone number with its country code (7–15 digits).' });
  }

  const current = currentRateWindow(ip);
  const now = Date.now();
  if (now - globalRequestWindow.startedAt >= limiterWindowMs) {
    globalRequestWindow = { startedAt: now, count: 0 };
  }
  if (globalRequestWindow.count >= MAX_GLOBAL_REQUESTS_PER_HOUR) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((limiterWindowMs - (now - globalRequestWindow.startedAt)) / 1000))));
    return res.status(429).json({ error: 'The public service has reached its hourly request limit. Please try later.' });
  }
  if (current.count >= MAX_REQUESTS_PER_HOUR) {
    const seconds = Math.max(1, Math.ceil((limiterWindowMs - (Date.now() - current.startedAt)) / 1000));
    res.set('Retry-After', String(seconds));
    return res.status(429).json({ error: 'Too many attempts from this network. Please try again later.' });
  }

  const numberKey = phoneCooldownKey(phoneNumber);
  const lastPhoneRequest = phoneCooldowns.get(numberKey) || 0;
  if (now - lastPhoneRequest < PHONE_COOLDOWN_MS) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((PHONE_COOLDOWN_MS - (now - lastPhoneRequest)) / 1000))));
    return res.status(429).json({ error: 'A recent pairing was attempted for this number. Please wait before trying again.' });
  }

  const ipSessions = activeByIp.get(ip) || new Set();
  if (ipSessions.size >= MAX_ACTIVE_PER_IP) {
    return res.status(429).json({ error: 'You already have a pairing request in progress. Finish or cancel it first.' });
  }

  const globalActive = Array.from(sessions.values()).filter(entry => !entry.finished && !entry.cancelled).length;
  if (globalActive >= MAX_ACTIVE_TOTAL) {
    return res.status(503).json({ error: 'The service is busy. Please try again in a few minutes.' });
  }
  if (!reserveSessionCapacity()) {
    return res.status(503).json({ error: 'The service is at capacity. Please try again later.' });
  }

  current.count += 1;
  globalRequestWindow.count += 1;
  phoneCooldowns.set(numberKey, now);
  const id = randomId();
  const entry = {
    id,
    accessToken: clientToken,
    clientTokenKey: tokenKey,
    phoneKey: numberKey,
    ip,
    phoneNumber,
    sessionDir: path.join(TEMP_ROOT, id),
    status: 'starting',
    message: 'Connecting securely to WhatsApp…',
    pairingCode: null,
    sessionId: null,
    sock: null,
    attempts: 0,
    retrying: false,
    finalizing: false,
    finished: false,
    cancelled: false,
    pendingAuthWrites: new Set(),
    authWriteError: null,
    socketListeners: null,
    expiryTimer: null,
    expiresAt: Date.now() + PAIRING_TIMEOUT_MS
  };
  sessions.set(id, entry);
  clientTokenIndex.set(tokenKey, id);
  ipSessions.add(id);
  activeByIp.set(ip, ipSessions);
  entry.expiryTimer = setTimeout(() => {
    if (!entry.finished && !entry.cancelled) {
      entry.finished = true;
      entry.status = 'failed';
      entry.message = 'This pairing request expired. Start a new request.';
      entry.phoneNumber = null;
      releaseActive(entry);
      cleanupSocketAndCredentials(entry).catch(() => {});
      scheduleResultDeletion(entry, RESULT_RETENTION_MS);
    }
  }, PAIRING_TIMEOUT_MS);
  entry.expiryTimer.unref?.();

  res.status(202).json({ requestId: id, status: entry.status, expiresInSeconds: Math.floor(PAIRING_TIMEOUT_MS / 1000) });
  issuePairingCode(entry, phoneNumber).catch(error => {
    failEntry(entry, 'The pairing service could not start. Please try again later.', error);
  });
});

app.get('/api/sessions/:requestId', (req, res) => {
  const entry = sessions.get(req.params.requestId);
  if (!entry || !hasValidAccessToken(req, entry)) return res.status(404).json({ error: 'This request has expired or does not exist. Start a new request.' });
  const payload = {
    status: entry.status,
    message: entry.message,
    expiresAt: entry.expiresAt
  };
  if (entry.status === 'code_ready') payload.pairingCode = entry.pairingCode;
  res.json(payload);
});

app.delete('/api/sessions/:requestId', sameOrigin, async (req, res) => {
  const entry = sessions.get(req.params.requestId);
  if (!entry || !hasValidAccessToken(req, entry)) return res.status(404).json({ error: 'This request has expired or does not exist.' });
  if (entry.finalizing) return res.status(409).json({ error: 'Pairing is finishing. Please wait for the self-chat delivery to complete.' });
  entry.cancelled = true;
  entry.finished = true;
  entry.status = 'cancelled';
  entry.message = 'Pairing cancelled. Temporary data was removed.';
  entry.phoneNumber = null;
  entry.accessToken = null;
  entry.pairingCode = null;
  entry.sessionId = null;
  if (entry.clientTokenKey) clientTokenIndex.delete(entry.clientTokenKey);
  clearExpiry(entry);
  releaseActive(entry);
  await cleanupSocketAndCredentials(entry);
  scheduleResultDeletion(entry, 60 * 1000);
  res.json({ status: entry.status, message: entry.message });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

prepareTempRoot();
const rateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of requestWindows) {
    if (now - record.startedAt >= limiterWindowMs) requestWindows.delete(ip);
  }
  for (const [key, requestedAt] of phoneCooldowns) {
    if (now - requestedAt >= PHONE_COOLDOWN_MS) phoneCooldowns.delete(key);
  }
}, 10 * 60 * 1000);
rateCleanupTimer.unref?.();

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`ASTRO X ULTRA public session website listening on port ${PORT}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping session website.`);
  clearInterval(rateCleanupTimer);
  server.close();
  const active = Array.from(sessions.values());
  for (const entry of active) {
    entry.cancelled = true;
    entry.finished = true;
    clearExpiry(entry);
    await cleanupSocketAndCredentials(entry);
    entry.sessionId = null;
    entry.phoneNumber = null;
    entry.accessToken = null;
  }
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
