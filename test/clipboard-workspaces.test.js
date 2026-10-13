const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Terminal } = require('@xterm/xterm');
const source = fs.readFileSync(require.resolve('../src/renderer/renderer.js'), 'utf8');

test('sandbox preload routes clipboard operations through asynchronous IPC', async () => {
  let api;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/preload.js'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return '한글'; } }
    })
  });
  assert.equal(await api.clipboard.readText(), '한글');
  await api.clipboard.writeText('복사');
  assert.deepEqual(calls, [['clipboard:read-text'], ['clipboard:write-text', '복사']]);
});

test('xterm copies UTF-8 OSC 52 with BEL, ST and tmux passthrough; ignores queries and replay', async () => {
  const terminal = new Terminal();
  const copied = [];
  const start = source.indexOf('  let replaying = false;');
  const end = source.indexOf('  const fitAddon =', start);
  const context = vm.createContext({ terminal, atob, Uint8Array, TextDecoder,
    window: { cmux: { clipboard: { writeText: async (text) => { copied.push(text); } } } },
    toast: () => {}
  });
  vm.runInContext(source.slice(start, end), context);
  const encoded = Buffer.from('한글 😀\nsecond line').toString('base64');
  const write = (text) => new Promise((resolve) => terminal.write(text, resolve));
  await write(`\x1b]52;c;${encoded}\x07`);
  await write(`\x1b]52;;${encoded}\x1b\\`);
  await write(`\x1bPtmux;\x1b\x1b]52;c;${encoded}\x07\x1b\\`);
  assert.deepEqual(copied, Array(3).fill('한글 😀\nsecond line'));
  await write('\x1b]52;c;?\x07');
  vm.runInContext('replaying = true', context);
  await write(`\x1b]52;c;${encoded}\x07`);
  assert.equal(copied.length, 3);
  terminal.dispose();
});

test('workspace drops move in both directions and save without remounting terminals', () => {
  const start = source.indexOf('    row.ondrop =');
  const end = source.indexOf('    const button =', start);
  for (const [from, to, y, expected] of [
    ['a', 'c', 90, 'bca'], ['c', 'a', 10, 'cab'],
    ['a', 'b', 10, 'abc'], ['c', 'b', 90, 'abc'],
    ['missing', 'a', 10, 'abc']
  ]) {
    let saves = 0;
    let renders = 0;
    const workspaces = ['a', 'b', 'c'].map((id) => ({ id }));
    const context = { state: { workspaces, activeWorkspaceId: 'b' }, draggedWorkspaceId: from,
      workspace: { id: to }, row: { classList: { remove() {} }, getBoundingClientRect: () => ({ top: 0, height: 100 }) },
      saveState: () => saves++, renderSidebar: () => renders++ };
    vm.runInNewContext(source.slice(start, end), context);
    context.row.ondrop({ clientY: y, preventDefault() {}, stopPropagation() {} });
    assert.equal(workspaces.map(({ id }) => id).join(''), expected);
    assert.equal(context.state.activeWorkspaceId, 'b');
    assert.equal(saves, from === 'missing' ? 0 : 1);
    assert.equal(renders, saves);
  }
});

test('resize bursts fit visible terminals only once per animation frame', () => {
  const frames = [];
  let fits = 0;
  const context = vm.createContext({ fitScheduled: false,
    requestAnimationFrame: (callback) => frames.push(callback),
    terminalViews: new Map([
      ['visible', { element: { isConnected: true }, fitAddon: { fit: () => { fits += 1; } } }],
      ['hidden', { element: { isConnected: false }, fitAddon: { fit: () => assert.fail('Hidden terminal resized') } }]
    ]) });
  vm.runInContext(source.slice(source.indexOf('function fitAll'), source.indexOf('window.cmux.terminal.onEvent')), context);
  vm.runInContext('fitAll(); fitAll(); fitAll();', context);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(fits, 1);
  vm.runInContext('fitAll()', context);
  frames.shift()();
  assert.equal(fits, 2);
});

test('moving a pane preserves both sessions on every split edge', () => {
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    const first = { id: 'a', type: 'terminal', sessionId: 'session-a' };
    const second = { id: 'b', type: 'terminal', sessionId: 'session-b' };
    const workspace = { root: { kind: 'split', first, second } };
    const context = vm.createContext({ state: {}, activeWorkspace: () => workspace,
      uid: () => 'split', render() {} });
    vm.runInContext(source.slice(source.indexOf('function countLeaves'), source.indexOf('function toast')), context);
    vm.runInContext(source.slice(source.indexOf('function movePane'), source.indexOf('function fitAll')), context);
    context.edge = edge;
    vm.runInContext("movePane('a', 'b', edge)", context);
    assert.equal(workspace.root.direction, ['top', 'bottom'].includes(edge) ? 'column' : 'row');
    const before = ['left', 'top'].includes(edge);
    assert.equal(workspace.root.first, before ? first : second);
    assert.equal(workspace.root.second, before ? second : first);
    assert.equal(context.state.activePaneId, 'a');
  }
});

test('workspace shortcuts leave an open SSH or command dialog intact', () => {
  let dialogOpen = true;
  let actions = 0;
  const context = vm.createContext({ inputMode: false,
    document: { querySelector: () => dialogOpen ? {} : null },
    shortcutFromEvent: () => 'Ctrl+W',
    state: { settings: { shortcuts: { closePane: 'Ctrl+W' } } },
    runShortcutAction: () => { actions += 1; } });
  vm.runInContext(source.slice(source.indexOf('function executeShortcut(event)'), source.indexOf('function runShortcutAction')), context);
  context.event = { type: 'keydown', key: 'w', ctrlKey: true,
    preventDefault() {}, stopPropagation() {} };
  assert.equal(vm.runInContext('executeShortcut(event)', context), false);
  assert.equal(actions, 0);
  dialogOpen = false;
  assert.equal(vm.runInContext('executeShortcut(event)', context), true);
  assert.equal(actions, 1);
});
