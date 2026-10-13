const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const main = fs.readFileSync(require.resolve('../src/main.js'), 'utf8');
const renderer = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');

test('private profile, credentials and terminal IPC reject guest and subframe senders', async () => {
  const handlers = new Map();
  const frame = {};
  const sender = { mainFrame: frame };
  const win = {};
  const profile = { workspaces: [] };
  let saved;
  const context = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { fromWebContents: (contents) => contents === sender ? win : null },
    clients: new Set([win]),
    privateStore: { read: () => profile, write: (_name, value) => { saved = value; } },
    requestWithRecovery: async () => 'ok', validateCredentialId: () => {},
    readCredentials: () => ({}), writeCredentials: () => {},
    safeStorage: { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('encrypted') },
    openExternalUrl: async () => true, clipboard: { readText: () => '', writeText() {} },
    shortcutSets: new WeakMap(), console, Buffer
  };
  const start = main.indexOf('  const requireAppSender');
  vm.runInNewContext(main.slice(start, main.indexOf('  createWindow();', start)), context);
  const args = { 'profile:load': [], 'profile:save': [profile], 'terminal:request': ['list', {}],
    'credentials:get': ['id'], 'credentials:set': ['id', 'secret'], 'credentials:delete': ['id'],
    'external:open-url': ['https://example.com'], 'clipboard:read-text': [], 'clipboard:write-text': ['text'],
    'window:control': ['close'], 'shortcuts:update': [{}] };
  for (const [name, parameters] of Object.entries(args)) {
    for (const event of [{ sender: {}, senderFrame: frame }, { sender, senderFrame: {} }]) {
      if (['window:control', 'shortcuts:update'].includes(name)) {
        assert.doesNotThrow(() => handlers.get(name)(event, ...parameters), name);
        assert.equal(context.shortcutSets.has(event.sender), false);
      } else assert.throws(() => handlers.get(name)(event, ...parameters), /허용되지 않은 앱 요청/, name);
    }
  }
  const event = { sender, senderFrame: frame };
  assert.equal(handlers.get('profile:load')(event), profile);
  handlers.get('profile:save')(event, profile);
  assert.equal(saved, profile);
  assert.equal(await handlers.get('terminal:request')(event, 'list', {}), 'ok');
});

test('SSH targets cannot be interpreted as options and key paths remain quoted', () => {
  const context = vm.createContext({});
  vm.runInContext(renderer.slice(renderer.indexOf('function quotePowerShellArg'), renderer.indexOf('function openSshConnection')), context);
  const connection = { name: 'Example', host: '-oProxyCommand=bad', user: '', port: '', key: '' };
  context.connection = connection;
  assert.ok(vm.runInContext('validateSshConnection(connection)', context));
  connection.host = 'example.com'; connection.user = 'user'; connection.key = "C:\\keys\\user's key";
  assert.equal(vm.runInContext('buildSshCommand(connection)', context), "ssh -i 'C:\\keys\\user''s key' 'user@example.com'");
});

test('invalid private layout fails instead of replacing personal settings', async () => {
  const context = vm.createContext({ window: { cmux: { profile: { load: async () => ({ workspaces: [] }) } } }, defaultState: () => ({ clean: true }) });
  vm.runInContext(renderer.slice(renderer.indexOf('function isValidNode'), renderer.indexOf('let state =')), context);
  await assert.rejects(vm.runInContext('loadState()', context), /비공개 설정/);
  context.window.cmux.profile.load = async () => null;
  assert.equal((await vm.runInContext('loadState()', context)).clean, true);
});

test('a fresh release starts without SSH connections or personal saved commands', () => {
  let sequence = 0;
  const context = vm.createContext({ uid: (prefix) => `${prefix}-${++sequence}` });
  vm.runInContext(renderer.slice(renderer.indexOf('const DEFAULT_SHORTCUTS'), renderer.indexOf('function isValidNode')), context);
  const fresh = vm.runInContext('defaultState()', context);
  assert.equal(fresh.ssh.connections.length, 0);
  assert.equal(fresh.commands.items.length, 0);
  assert.equal(fresh.workspaces.length, 1);
  assert.equal(fresh.workspaces[0].root.type, 'terminal');
  assert.equal(fresh.workspaces[0].root.pendingCommand, undefined);
});
