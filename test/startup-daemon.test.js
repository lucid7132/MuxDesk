const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const daemon = fs.readFileSync(path.join(root, 'src/terminal-daemon.js'), 'utf8');

test('profiles stay beside each portable EXE and Chromium caches stay local', (t) => {
  const directory = fs.mkdtempSync(path.join(root, '.env', 'startup-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scenarios = [
    { packaged: false, environment: {}, expected: path.join(directory, '.env') },
    ...['release', 'desktop'].map((name) => ({ packaged: true,
      environment: { PORTABLE_EXECUTABLE_DIR: path.join(directory, name) },
      expected: path.join(directory, name, '.env') })),
    { packaged: true, environment: {}, expected: path.join(directory, 'raw', '.env') },
    { packaged: true, environment: { CMUX_PRIVATE_DIR: path.join(directory, 'custom') },
      expected: path.join(directory, 'custom') }
  ];
  const profiles = new Set();
  for (const { packaged, environment, expected } of scenarios) {
    const configured = {};
    let privateDirectory;
    const appData = path.join(directory, 'local-appdata');
    const app = { isPackaged: packaged, getAppPath: () => directory,
      getPath: () => appData,
      setPath: (name, value) => { assert(fs.existsSync(value)); configured[name] = value; } };
    vm.runInNewContext(main.slice(0, main.indexOf('function readCredentials')), {
      require: (name) => name === 'electron' ? { app } : name === './private-store'
        ? { createPrivateStore: (value) => { privateDirectory = value; return require('../src/private-store').createPrivateStore(value); } }
        : require(name),
      process: { env: environment, execPath: path.join(directory, 'raw', 'cmux.exe') }
    });
    assert.equal(privateDirectory, expected);
    const slot = require('node:crypto').createHash('sha256').update(expected).digest('hex').slice(0, 16);
    assert.equal(configured.userData, path.join(appData, 'cmux-public-v1', 'runtime', slot));
    assert.equal(configured.sessionData, path.join(configured.userData, 'chromium'));
    assert(!profiles.has(configured.userData));
    profiles.add(configured.userData);
  }
});

test('first terminal input waits for daemon startup rather than being dropped', async () => {
  const order = [];
  const context = vm.createContext({ recoveryPromise: Promise.resolve().then(() => order.push('ready')),
    request: async () => { order.push('write'); return true; } });
  vm.runInContext(main.slice(main.indexOf('async function requestWithRecovery'), main.indexOf('function createWindow')), context);
  assert.equal(await vm.runInContext("requestWithRecovery('write', {})", context), true);
  assert.deepEqual(order, ['ready', 'write']);
});

function createDaemon() {
  let accept;
  let onExit;
  let options;
  const writes = [];
  const terminal = { onData() {}, onExit: (handler) => { onExit = handler; },
    write: (data) => writes.push(data), resize() {}, kill() {} };
  vm.runInNewContext(daemon, {
    require: (name) => name === 'net' ? { createServer: (handler) => { accept = handler; return { listen() {} }; } }
      : name === 'node-pty' ? { spawn: (_file, _args, value) => { options = value; return terminal; } }
        : require(name),
    process: { env: { CMUX_PIPE: 'test-pipe', CMUX_PRIVATE_DIR: 'private', ELECTRON_RUN_AS_NODE: '1' } }, Buffer
  });
  const socket = new EventEmitter();
  socket.writable = true; socket.writableLength = 0;
  socket.setEncoding = () => {};
  const messages = [];
  socket.write = (packet) => messages.push(JSON.parse(packet));
  socket.destroy = () => { socket.destroyed = true; };
  accept(socket);
  const request = (method, params = {}) => {
    socket.emit('data', `${JSON.stringify({ id: messages.length + 1, method, params })}\n`);
    return messages.at(-1);
  };
  return { socket, request, messages, writes, options: () => options, exit: () => onExit({ exitCode: 0 }) };
}

test('daemon creates, writes, validates, restores and removes terminal sessions', () => {
  const daemon = createDaemon();
  assert.equal(daemon.request('create', { id: 'session' }).result.id, 'session');
  assert.equal(daemon.options().env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(daemon.options().env.CMUX_PRIVATE_DIR, undefined);
  assert.equal(daemon.options().env.CMUX_PIPE, undefined);
  assert.equal(daemon.request('write', { id: 'session', data: 'echo test\r' }).result, true);
  assert.deepEqual(daemon.writes, ['echo test\r']);
  assert.match(daemon.request('resize', { id: 'session', cols: 0, rows: 30 }).error, /올바른 터미널 크기/);
  assert.equal(daemon.request('attach', { id: 'session' }).result.id, 'session');
  daemon.exit();
  assert.equal(daemon.request('list').result.length, 0);
});

test('daemon handles batched valid packets and rejects oversized incomplete input', () => {
  const daemon = createDaemon();
  const packet = `${JSON.stringify({ id: 1, method: 'list', params: { padding: 'x'.repeat(600000) } })}\n`;
  daemon.socket.emit('data', packet + packet);
  assert.equal(daemon.messages.length, 2);
  assert.equal(daemon.socket.destroyed, undefined);
  daemon.socket.emit('data', 'x'.repeat(1024 * 1024 + 1));
  assert.equal(daemon.socket.destroyed, true);
});

test('window diagnostics record Electron console errors and renderer exits', () => {
  let window;
  const records = [];
  class Window extends EventEmitter {
    constructor() {
      super(); window = this;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
    }
    show() { this.shown = true; }
    loadFile() {}
  }
  const context = vm.createContext({ BrowserWindow: Window, path,
    __dirname: path.join(root, 'src'), clients: new Set(),
    logApplication: (event, details = {}) => records.push({ event, ...details }) });
  vm.runInContext(main.slice(main.indexOf('function createWindow'), main.indexOf('const hasSingleInstanceLock')), context);
  vm.runInContext('createWindow()', context);
  window.webContents.emit('console-message', { level: 'error', message: 'renderer failed' });
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  window.emit('ready-to-show');
  assert.deepEqual(records, [
    { event: 'renderer_error', message: 'renderer failed' },
    { event: 'renderer_process_gone', reason: 'crashed', exitCode: 1 },
    { event: 'window_ready' }
  ]);
  assert.equal(window.shown, true);
});
