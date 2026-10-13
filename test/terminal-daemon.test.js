const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

let daemonProcess;
const PIPE = `\\\\.\\pipe\\cmux-terminal-test-${process.pid}`;

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PIPE);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function connectOrStart() {
  try { return await connect(); } catch (_) {}
  const daemon = spawn(process.env.CMUX_TEST_EXECUTABLE || process.execPath, [process.env.CMUX_TEST_DAEMON || path.join(__dirname, '..', 'src', 'terminal-daemon.js')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CMUX_PIPE: PIPE, CMUX_TEST_RESULT: 'OK' }
  });
  daemonProcess = daemon;
  daemon.unref();
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { return await connect(); } catch (_) {}
  }
  throw new Error('daemon connection failed');
}

test('ConPTY session accepts input and returns output', { timeout: 10000, skip: process.platform !== 'win32' }, async (t) => {
  let socket;
  t.after(() => { socket?.destroy(); daemonProcess?.kill(); });
  socket = await connectOrStart();
  const pending = new Map();
  let sequence = 1;
  let buffer = '';
  let output = '';

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      if (message.replyTo) {
        pending.get(message.replyTo)?.(message);
        pending.delete(message.replyTo);
      } else if (message.event === 'data') output += message.data;
    }
  });

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = sequence++;
    pending.set(id, (message) => message.error ? reject(new Error(message.error)) : resolve(message.result));
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
  });

  const sessionId = `test-${Date.now()}`;
  await request('create', { id: sessionId, shell: process.env.COMSPEC || 'cmd.exe' });
  await request('attach', { id: sessionId });
  await assert.rejects(request('write', { id: 'missing-session', data: 'x' }), /세션을 찾을 수 없습니다/);
  await assert.rejects(request('resize', { id: sessionId, cols: 0, rows: 30 }), /올바른 터미널 크기/);
  assert.ok((await request('list')).some((session) => session.id === sessionId));
  await request('write', { id: sessionId, data: 'echo CMUX_SMOKE_%CMUX_TEST_RESULT% 한글테스트\r' });

  for (let i = 0; i < 40 && !output.includes('CMUX_SMOKE_OK'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(output, /CMUX_SMOKE_OK/);
  assert.match(output, /한글테스트/);
  await request('close', { id: sessionId });
  for (let i = 0; i < 20 && (await request('list')).some((session) => session.id === sessionId); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await request('create', { id: sessionId, shell: process.env.COMSPEC || 'cmd.exe' });
  assert.equal((await request('attach', { id: sessionId })).id, sessionId);
  await request('close', { id: sessionId });
  socket.end();
});
