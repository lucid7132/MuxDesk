const net = require('net');
const os = require('os');
const pty = require('node-pty');

const PIPE = process.env.CMUX_PIPE;
if (!PIPE) throw new Error('CMUX_PIPE is required; start the daemon through cmux.');
const sessions = new Map();
const sockets = new Set();
const MAX_SCROLLBACK = 10_000_000;
const MAX_MESSAGE_SIZE = 1024 * 1024;
const MAX_SOCKET_BUFFER = 64 * 1024 * 1024;

function requireSession(id) {
  if (typeof id !== 'string' || !id || id.length > 128) throw new Error('올바른 세션 ID가 필요합니다.');
  const session = sessions.get(id);
  if (!session) throw new Error('세션을 찾을 수 없습니다.');
  return session;
}

function send(socket, message) {
  if (!socket.writable || socket.destroyed) return;
  const packet = `${JSON.stringify(message)}\n`;
  if (socket.writableLength + Buffer.byteLength(packet) > MAX_SOCKET_BUFFER) return socket.destroy();
  socket.write(packet);
}

function broadcast(message) {
  for (const socket of sockets) send(socket, message);
}

function createSession({ id, cwd, shell }) {
  if (typeof id !== 'string' || !id || id.length > 128) throw new Error('올바른 세션 ID가 필요합니다.');
  if (sessions.has(id)) return sessions.get(id);
  if (cwd != null && (typeof cwd !== 'string' || cwd.length > 32768)) throw new Error('올바른 작업 폴더가 필요합니다.');
  if (shell != null && (typeof shell !== 'string' || !shell || shell.length > 32768)) throw new Error('올바른 셸 경로가 필요합니다.');
  const executable = shell || 'powershell.exe';
  const environment = { ...process.env, TERM: 'xterm-256color' };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.CMUX_PIPE;
  delete environment.CMUX_PRIVATE_DIR;
  const terminal = pty.spawn(executable, [], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: cwd || os.homedir(),
    env: environment,
    useConpty: true
  });
  const session = { id, terminal, cwd: cwd || os.homedir(), shell: executable, buffer: '' };
  sessions.set(id, session);
  terminal.onData((data) => {
    session.buffer += data;
    if (session.buffer.length > MAX_SCROLLBACK + 65536) session.buffer = session.buffer.slice(-MAX_SCROLLBACK);
    broadcast({ event: 'data', sessionId: id, data });
  });
  terminal.onExit(({ exitCode }) => {
    broadcast({ event: 'exit', sessionId: id, exitCode });
    sessions.delete(id);
  });
  return session;
}

const handlers = {
  list: () => [...sessions.values()].map(({ id, cwd, shell }) => ({ id, cwd, shell })),
  create: (params) => {
    const session = createSession(params);
    return { id: session.id, cwd: session.cwd, shell: session.shell };
  },
  attach: ({ id }) => {
    const session = requireSession(id);
    return { id, buffer: session.buffer, cwd: session.cwd, shell: session.shell };
  },
  write: ({ id, data }) => {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE_SIZE) throw new Error('올바른 터미널 입력이 필요합니다.');
    requireSession(id).terminal.write(data);
    return true;
  },
  resize: ({ id, cols, rows }) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 1000 || rows > 1000) {
      throw new Error('올바른 터미널 크기가 필요합니다.');
    }
    requireSession(id).terminal.resize(cols, rows);
    return true;
  },
  close: ({ id }) => { requireSession(id).terminal.kill(); return true; }
};

const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!raw) continue;
      if (Buffer.byteLength(raw) > MAX_MESSAGE_SIZE) { socket.destroy(); return; }
      let request;
      try {
        request = JSON.parse(raw);
        if (!request || typeof request !== 'object') throw new Error('올바른 요청이 아닙니다.');
        if (!Object.hasOwn(handlers, request.method)) throw new Error('알 수 없는 요청입니다.');
        const result = handlers[request.method](request.params || {});
        send(socket, { replyTo: request.id ?? null, result });
      } catch (error) {
        send(socket, { replyTo: request?.id ?? null, error: error.message });
      }
    }
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_SIZE) socket.destroy();
  });
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
});

server.listen(PIPE);
