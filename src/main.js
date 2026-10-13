const { app, BrowserWindow, ipcMain, safeStorage, shell, clipboard } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('node:fs');
const { createPrivateStore } = require('./private-store');
const { createHash } = require('node:crypto');

// Keep each private profile and its persistent terminal daemon isolated.
const configuredPrivateDirectory = process.env.CMUX_PRIVATE_DIR
  ? path.resolve(process.env.CMUX_PRIVATE_DIR) : null;
const userDataDirectory = configuredPrivateDirectory
  ? path.join(configuredPrivateDirectory, 'runtime')
  : app.isPackaged ? path.join(app.getPath('appData'), 'cmux-public-v1')
    : path.join(app.getAppPath(), '.env', 'runtime');
const sessionDataDirectory = path.join(userDataDirectory, 'chromium');
for (const directory of [userDataDirectory, sessionDataDirectory]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
app.setPath('userData', userDataDirectory);
app.setPath('sessionData', sessionDataDirectory);
const privateDirectory = configuredPrivateDirectory
  || (app.isPackaged ? path.join(userDataDirectory, '.env') : path.join(app.getAppPath(), '.env'));
const privateStore = createPrivateStore(privateDirectory);
const diagnosticsDirectory = path.join(privateDirectory, 'logs');
fs.mkdirSync(diagnosticsDirectory, { recursive: true, mode: 0o700 });
function logApplication(event, details = {}) {
  try {
    const filename = path.join(diagnosticsDirectory, 'application.jsonl');
    if (fs.existsSync(filename) && fs.statSync(filename).size > 1024 * 1024) {
      fs.renameSync(filename, `${filename}.previous`);
    }
    fs.appendFileSync(filename, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...details })}\n`, { mode: 0o600 });
  } catch (_) { /* Diagnostic failure must not terminate the application. */ }
}
logApplication('startup', { packaged: app.isPackaged });

const profileSlot = createHash('sha256').update(privateDirectory).digest('hex').slice(0, 16);
const { spawn } = require('child_process');

const PIPE_CANDIDATES = [...'abcdefgh'].map((slot) => `\\\\.\\pipe\\cmux-public-v1-${profileSlot}-${slot}`);
const TERMINAL_METHODS = new Set(['list', 'create', 'attach', 'write', 'resize', 'close']);
const SAFE_RETRY_METHODS = new Set(['list', 'create', 'attach', 'resize', 'close']);
const MAX_RESPONSE_SIZE = 64 * 1024 * 1024;
const clients = new Set();
const shortcutSets = new WeakMap();
let daemonSocket = null;
let daemonPipe = null;
let receiveBuffer = '';
let nextId = 1;
let recoveryPromise = null;
const pending = new Map();
const failedPipes = new Set();

function readCredentials() {
  const credentials = privateStore.read('ssh-credentials.json', {});
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('자격 증명 파일 형식이 올바르지 않습니다.');
  return credentials;
}

function writeCredentials(credentials) {
  privateStore.write('ssh-credentials.json', credentials);
}

function validateCredentialId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) {
    throw new Error('올바른 자격 증명 ID가 필요합니다.');
  }
}

async function openExternalUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP 또는 HTTPS 주소만 열 수 있습니다.');
  return shell.openExternal(url.href);
}

function recoverableError(message) {
  const error = new Error(message);
  error.recoverable = true;
  return error;
}

function connect(pipeName) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    socket.setEncoding('utf8');
    socket.once('connect', async () => {
      daemonSocket = socket;
      daemonPipe = pipeName;
      receiveBuffer = '';
      socket.on('data', (chunk) => { if (daemonSocket === socket) onData(chunk); });
      socket.on('error', () => {});
      socket.on('close', () => {
        if (daemonSocket === socket) { daemonSocket = null; daemonPipe = null; }
        for (const [id, request] of pending) {
          if (request.socket !== socket) continue;
          const { reject: rejectPending, timer } = request;
          clearTimeout(timer);
          rejectPending(recoverableError('터미널 데몬 연결이 끊어졌습니다.'));
          pending.delete(id);
        }
      });
      try { await request('list'); resolve(); }
      catch (error) {
        if (daemonSocket === socket) { daemonSocket = null; daemonPipe = null; }
        socket.destroy();
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

function probe(pipeName, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.createConnection(pipeName);
    socket.setEncoding('utf8');
    let connected = false;
    let buffer = '';
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    };
    const timer = setTimeout(() => finish(connected ? 'unresponsive' : 'unavailable'), timeoutMs);
    socket.once('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({ id: -1, method: 'list', params: {} })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (buffer.length > MAX_RESPONSE_SIZE) return finish('unresponsive');
      if (newline === -1) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        finish(message.replyTo === -1 && !message.error ? 'healthy' : 'unresponsive');
      } catch (_) { finish('unresponsive'); }
    });
    socket.once('error', () => finish('unavailable'));
  });
}

function startDaemon(pipeName) {
  const daemonPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'terminal-daemon.js')
    : path.join(__dirname, 'terminal-daemon.js');
  const daemon = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CMUX_PIPE: pipeName }
  });
  daemon.on('error', () => console.error('cmux terminal daemon could not be launched'));
  daemon.unref();
}

async function ensureDaemon() {
  let availablePipe = null;
  for (const pipeName of PIPE_CANDIDATES) {
    if (failedPipes.has(pipeName)) continue;
    const status = await probe(pipeName);
    if (status === 'healthy') {
      try { await connect(pipeName); return; }
      catch (_) { failedPipes.add(pipeName); continue; }
    }
    if (status === 'unresponsive') failedPipes.add(pipeName);
    if (status === 'unavailable' && !availablePipe) availablePipe = pipeName;
  }
  if (!availablePipe) throw new Error('사용 가능한 터미널 데몬 슬롯이 없습니다.');
  startDaemon(availablePipe);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await probe(availablePipe) === 'healthy') {
      try { await connect(availablePipe); return; }
      catch (_) {}
    }
  }
  throw new Error('터미널 데몬을 시작하지 못했습니다.');
}

function onData(chunk) {
  receiveBuffer += chunk.toString('utf8');
  let newline;
  while ((newline = receiveBuffer.indexOf('\n')) !== -1) {
    const raw = receiveBuffer.slice(0, newline);
    receiveBuffer = receiveBuffer.slice(newline + 1);
    if (!raw) continue;
    if (raw.length > MAX_RESPONSE_SIZE) { daemonSocket?.destroy(); return; }
    let message;
    try { message = JSON.parse(raw); }
    catch (_) { daemonSocket?.destroy(); return; }
    if (message.replyTo != null && pending.has(message.replyTo)) {
      const { resolve, reject, timer } = pending.get(message.replyTo);
      pending.delete(message.replyTo);
      clearTimeout(timer);
      message.error ? reject(new Error(message.error)) : resolve(message.result);
    } else {
      for (const window of clients) if (!window.isDestroyed()) window.webContents.send('terminal:event', message);
    }
  }
  if (receiveBuffer.length > MAX_RESPONSE_SIZE) daemonSocket?.destroy();
}

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!TERMINAL_METHODS.has(method)) return reject(new Error('허용되지 않은 터미널 요청입니다.'));
    const socket = daemonSocket;
    if (!socket) return reject(recoverableError('터미널 데몬에 연결되지 않았습니다.'));
    const id = nextId++;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(recoverableError(`${method} 요청 시간이 초과되었습니다.`));
    }, 5000);
    timer.unref();
    pending.set(id, { resolve, reject, timer, socket });
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

async function requestWithRecovery(method, params) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (recoveryPromise) await recoveryPromise;
      return await request(method, params);
    }
    catch (error) {
      if (!error.recoverable || attempt === 3) throw error;
      if (daemonPipe) failedPipes.add(daemonPipe);
      if (!recoveryPromise) {
        recoveryPromise = (async () => {
          daemonSocket?.destroy();
          daemonSocket = null;
          await ensureDaemon();
        })().finally(() => { recoveryPromise = null; });
      }
      await recoveryPromise;
      if (!SAFE_RETRY_METHODS.has(method)) throw error;
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#111318',
    backgroundMaterial: 'mica',
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  });
  clients.add(win);
  win.once('ready-to-show', () => { logApplication('window_ready'); win.show(); });
  win.webContents.on('did-fail-load', (_event, code, message, _url, mainFrame) => {
    if (mainFrame) logApplication('renderer_load_failed', { code, message });
  });
  win.webContents.on('render-process-gone', (_event, details) => logApplication('renderer_process_gone', details));
  win.webContents.on('console-message', (details) => {
    if (details?.level === 'error') {
      logApplication('renderer_error', { message: details.message });
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    try {
      if (!['http:', 'https:'].includes(new URL(params.src).protocol)) return event.preventDefault();
    } catch (_) { return event.preventDefault(); }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    guest.session.setPermissionCheckHandler(() => false);
    guest.on('will-navigate', (event, url) => {
      try { if (!['http:', 'https:'].includes(new URL(url).protocol)) event.preventDefault(); }
      catch (_) { event.preventDefault(); }
    });
    guest.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url).catch(() => {});
      return { action: 'deny' };
    });
    guest.on('before-input-event', (keyboardEvent, input) => {
      if (input.type !== 'keyDown') return;
      const parts = [];
      if (input.control) parts.push('Ctrl');
      if (input.shift) parts.push('Shift');
      if (input.alt) parts.push('Alt');
      if (input.meta) parts.push('Meta');
      let key = input.key;
      if (key === ' ') key = 'Space';
      else if (key === 'Escape') key = 'Esc';
      else if (/^insert$/i.test(key) || input.code === 'Insert' || input.code === 'Numpad0') key = 'Insert';
      else if (key.length === 1 && /[a-z]/i.test(key)) key = key.toUpperCase();
      parts.push(key);
      const shortcut = parts.join('+');
      if (!shortcutSets.get(win.webContents)?.has(shortcut)) return;
      keyboardEvent.preventDefault();
      if (['Ctrl+Tab', 'Ctrl+Insert', 'F11'].includes(shortcut) && input.isAutoRepeat) return;
      win.webContents.send('shortcut:pressed', shortcut);
    });
  });
  win.on('closed', () => clients.delete(win));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) { logApplication('instance_lock_denied'); app.quit(); }

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win?.isMinimized()) win.restore();
  win?.focus();
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  logApplication('app_ready');
  const requireAppSender = (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !clients.has(win) || event.senderFrame !== event.sender.mainFrame) throw new Error('허용되지 않은 앱 요청입니다.');
  };
  ipcMain.handle('clipboard:read-text', (event) => {
    requireAppSender(event);
    return clipboard.readText();
  });
  ipcMain.handle('clipboard:write-text', (event, text) => {
    requireAppSender(event);
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('복사할 텍스트가 너무 큽니다.');
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('profile:load', (event) => { requireAppSender(event); return privateStore.read('profile.json'); });
  const saveProfile = (event, profile) => {
    requireAppSender(event);
    if (!profile || typeof profile !== 'object' || !Array.isArray(profile.workspaces)) throw new Error('올바른 프로필이 필요합니다.');
    privateStore.write('profile.json', profile);
    return true;
  };
  ipcMain.handle('profile:save', saveProfile);
  ipcMain.on('profile:flush', (event, profile) => {
    try { saveProfile(event, profile); }
    catch (_) { console.error('cmux private profile flush failed'); }
  });
  ipcMain.handle('terminal:request', (event, method, params) => { requireAppSender(event); return requestWithRecovery(method, params); });
  ipcMain.handle('credentials:set', (event, id, password) => {
    requireAppSender(event);
    validateCredentialId(id);
    if (typeof password !== 'string' || !password || password.length > 32768) throw new Error('올바른 비밀번호가 필요합니다.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 보안 저장소를 사용할 수 없습니다.');
    const credentials = readCredentials();
    credentials[id] = safeStorage.encryptString(password).toString('base64');
    writeCredentials(credentials);
    return true;
  });
  ipcMain.handle('credentials:get', (event, id) => {
    requireAppSender(event);
    validateCredentialId(id);
    const encrypted = readCredentials()[id];
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
    catch (_) { return ''; }
  });
  ipcMain.handle('credentials:delete', (event, id) => {
    requireAppSender(event);
    validateCredentialId(id);
    const credentials = readCredentials();
    delete credentials[id];
    writeCredentials(credentials);
    return true;
  });
  ipcMain.handle('external:open-url', (event, url) => { requireAppSender(event); return openExternalUrl(url); });
  ipcMain.on('window:control', (event, action) => {
    try { requireAppSender(event); } catch (_) { return; }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === 'close') win.close();
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
  });
  ipcMain.on('shortcuts:update', (event, shortcuts) => {
    try { requireAppSender(event); } catch (_) { return; }
    const values = shortcuts && typeof shortcuts === 'object' ? Object.values(shortcuts) : [];
    shortcutSets.set(event.sender, new Set(values.filter((value) => typeof value === 'string' && value.length <= 64).slice(0, 32)));
  });
  createWindow();
  recoveryPromise = ensureDaemon().finally(() => { recoveryPromise = null; });
  recoveryPromise.catch((error) => console.error('cmux daemon startup failed:', error));
}).catch((error) => {
  logApplication('startup_failed', { message: error.message, stack: error.stack });
  console.error('cmux startup failed:', error);
  const { dialog } = require('electron');
  dialog.showErrorBox('cmux 시작 실패', error.message);
  app.quit();
});

app.on('window-all-closed', () => {
  logApplication('all_windows_closed');
  // The detached terminal daemon intentionally remains alive.
  app.quit();
});
