/* global Terminal, FitAddon, WebLinksAddon */
(async () => {
const $ = (selector) => document.querySelector(selector);
const uid = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const stage = $('#stage');
const terminalViews = new Map();
let draggedLeafId = null;
let draggedWorkspaceId = null;
let draggedSavedItem = null;
let saveTimer = null;
let toastTimer = null;
let fitScheduled = false;
let openWorkspaceMenuId = null;
let currentDropEdge = null;
let lastPaneSwitchAt = 0;
let maximizedPaneId = null;
let inputMode = false;

const SHELL_PRESENTATION = {
  powershell: { title: 'PowerShell', icon: 'PS' },
  cmd: { title: 'Command Prompt', icon: 'C:' },
  ssh: { title: 'SSH', icon: '↗' },
  terminal: { title: 'Terminal', icon: '>_' },
};

const DEFAULT_SHORTCUTS = {
  splitRight: 'Ctrl+D',
  splitDown: 'Ctrl+Shift+B',
  closePane: 'Ctrl+W',
  newWorkspace: 'Ctrl+N',
  newBrowser: 'Ctrl+Shift+N',
  nextPane: 'Ctrl+Tab',
  toggleSidebar: 'Ctrl+B',
  openSettings: 'Ctrl+,',
  toggleFullscreen: 'F11',
  workspace1: 'Ctrl+1',
  workspace2: 'Ctrl+2',
  workspace3: 'Ctrl+3',
  workspace4: 'Ctrl+4',
  workspace5: 'Ctrl+5',
  workspace6: 'Ctrl+6',
  workspace7: 'Ctrl+7',
  workspace8: 'Ctrl+8',
  workspace9: 'Ctrl+9',
};

const SHORTCUT_DEFINITIONS = [
  ['splitRight', '오른쪽에 터미널 분할', '현재 패널 오른쪽에 새 터미널을 만듭니다.'],
  ['splitDown', '아래쪽에 터미널 분할', '현재 패널 아래에 새 터미널을 만듭니다.'],
  ['closePane', '현재 패널 닫기', '선택한 터미널 또는 브라우저를 닫습니다.'],
  ['newWorkspace', '새 워크스페이스', '새 워크스페이스와 터미널을 만듭니다.'],
  ['newBrowser', '새 브라우저', '현재 패널 오른쪽에 브라우저를 엽니다.'],
  ['nextPane', '다음 터미널로 이동', '현재 워크스페이스의 다음 터미널로 이동합니다.'],
  ['toggleSidebar', '사이드바 접기/펼치기', '워크스페이스 사이드바 표시 형태를 전환합니다.'],
  ['openSettings', '설정 열기', '단축키 설정창을 엽니다.'],
  ['toggleFullscreen', '앱 전체 화면', 'cmux 창 전체 화면을 전환합니다.'],
];

function terminalLeaf() {
  return { id: uid('pane'), type: 'terminal', sessionId: uid('term'), title: 'PowerShell', shellType: 'powershell', titleCustomized: false };
}

function browserLeaf() {
  return { id: uid('pane'), type: 'browser', url: 'https://www.google.com', title: 'Browser' };
}

function sshLeaf(connection) {
  return {
    ...terminalLeaf(),
    title: connection.name,
    shellType: 'ssh',
    titleCustomized: true,
    pendingCommand: buildSshCommand(connection),
    commandSent: false,
    sshConnectionId: connection.id,
    autoPassword: Boolean(connection.passwordSaved),
  };
}

function defaultState() {
  const workspaceId = uid('ws');
  return {
    activeWorkspaceId: workspaceId,
    activePaneId: null,
    sidebar: { width: 220, collapsed: false },
    ssh: { collapsed: false, connections: [] },
    commands: { collapsed: false, items: [] },
    settings: { shortcuts: { ...DEFAULT_SHORTCUTS }, terminalFontSize: 13 },
    workspaces: [{ id: workspaceId, name: 'Workspace 1', note: '~', icon: '', color: '#5b8cff', root: terminalLeaf() }]
  };
}

function isValidNode(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 64) return false;
  if (node.kind === 'split') {
    return ['row', 'column'].includes(node.direction) && Number.isFinite(node.ratio)
      && node.ratio > 0 && node.ratio < 1 && isValidNode(node.first, depth + 1) && isValidNode(node.second, depth + 1);
  }
  return typeof node.id === 'string' && ['terminal', 'browser'].includes(node.type)
    && (node.type !== 'terminal' || typeof node.sessionId === 'string');
}

async function loadState() {
  try {
    const saved = await window.cmux.profile.load();
    if (saved === null) return defaultState();
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.workspaces) || !saved.workspaces.length) throw new Error('잘못된 프로필');
    if (saved.workspaces.some((workspace) => !workspace || typeof workspace.id !== 'string' || typeof workspace.name !== 'string' || (workspace.root && !isValidNode(workspace.root)))) throw new Error('잘못된 레이아웃');
    if (saved.ssh?.connections && (!Array.isArray(saved.ssh.connections) || saved.ssh.connections.some((connection) => !connection || ['id', 'name', 'host', 'user', 'port', 'key'].some((key) => typeof connection[key] !== 'string')))) throw new Error('잘못된 SSH 설정');
    if (saved.commands?.items && (!Array.isArray(saved.commands.items) || saved.commands.items.some((command) => !command || ['id', 'name', 'value'].some((key) => typeof command[key] !== 'string')))) throw new Error('잘못된 명령어 설정');
    return saved;
  }
  catch (_) { throw new Error('비공개 설정을 읽을 수 없습니다. .env/profile.json을 확인하세요.'); }
}

let state = await loadState();
state.sidebar = { width: 220, collapsed: false, ...(state.sidebar || {}) };
state.ssh = { collapsed: false, connections: [], ...(state.ssh || {}) };
if (!Array.isArray(state.ssh.connections)) state.ssh.connections = [];
state.commands = { collapsed: false, items: [], ...(state.commands || {}) };
if (!Array.isArray(state.commands.items)) state.commands.items = [];
state.settings = { ...(state.settings || {}), shortcuts: { ...DEFAULT_SHORTCUTS, ...(state.settings?.shortcuts || {}) } };
state.settings.terminalFontSize = Math.max(10, Math.min(24, state.settings.terminalFontSize || 13));
if (!state.workspaces.some((workspace) => workspace.id === state.activeWorkspaceId)) state.activeWorkspaceId = state.workspaces[0].id;
state.workspaces.forEach((workspace, index) => {
  workspace.color ||= ['#5b8cff', '#56c596', '#e69c55', '#b777e8'][index % 4];
  workspace.note ||= '~';
  workspace.icon ||= '';
});
const activeWorkspace = () => state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId);

function saveState() {
  clearTimeout(saveTimer);
  window.cmux.profile.save(state).catch(() => toast('비공개 설정을 저장할 수 없습니다.'));
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 80);
}
window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); window.cmux.profile.flush(state); });

function countLeaves(node) {
  if (!node) return 0;
  return node.kind === 'split' ? countLeaves(node.first) + countLeaves(node.second) : 1;
}

function collectLeaves(node, result = []) {
  if (!node) return result;
  if (node.kind !== 'split') result.push(node);
  else { collectLeaves(node.first, result); collectLeaves(node.second, result); }
  return result;
}

function findLeaf(node, id) {
  if (!node) return null;
  if (node.kind !== 'split') return node.id === id ? node : null;
  return findLeaf(node.first, id) || findLeaf(node.second, id);
}

function replaceNode(node, id, replacement) {
  if (!node) return node;
  if (node.kind !== 'split') return node.id === id ? replacement : node;
  return { ...node, first: replaceNode(node.first, id, replacement), second: replaceNode(node.second, id, replacement) };
}

function removeLeaf(node, id) {
  if (!node) return null;
  if (node.kind !== 'split') return node.id === id ? null : node;
  const first = removeLeaf(node.first, id);
  const second = removeLeaf(node.second, id);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function addBeside(newLeaf, targetId = state.activePaneId, edge = 'right') {
  const workspace = activeWorkspace();
  if (!workspace.root) { workspace.root = newLeaf; state.activePaneId = newLeaf.id; return; }
  const target = findLeaf(workspace.root, targetId) || firstLeaf(workspace.root);
  const before = edge === 'left' || edge === 'top';
  const split = {
    kind: 'split', id: uid('split'), direction: edge === 'top' || edge === 'bottom' ? 'column' : 'row', ratio: 0.5,
    first: before ? newLeaf : target, second: before ? target : newLeaf
  };
  workspace.root = replaceNode(workspace.root, target.id, split);
  state.activePaneId = newLeaf.id;
}

function firstLeaf(node) { return node?.kind === 'split' ? firstLeaf(node.first) : node; }

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('visible'), 2600);
}

function beginInlineRename(element, currentName, commit) {
  const input = document.createElement('input');
  input.className = 'pane-name-editor';
  input.value = currentName;
  element.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (save && value) commit(value);
    else render();
  };
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

function quotePowerShellArg(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function validateSshConnection(connection) {
  if (!connection.name.trim()) return '표시 이름을 입력하세요.';
  if (!/^(?!-)[a-zA-Z0-9._:[\]-]+$/.test(connection.host.trim())) return 'Host 또는 Config 별칭 형식이 올바르지 않습니다.';
  if (connection.user && !/^[a-zA-Z0-9._-]+$/.test(connection.user)) return '사용자 이름 형식이 올바르지 않습니다.';
  if (connection.port && (!Number.isInteger(Number(connection.port)) || Number(connection.port) < 1 || Number(connection.port) > 65535)) return '포트는 1~65535 사이여야 합니다.';
  if (/[\r\n]/.test(connection._password || '')) return '비밀번호에는 줄바꿈을 사용할 수 없습니다.';
  return '';
}

function buildSshCommand(connection) {
  const args = [];
  if (connection.port) args.push('-p', String(connection.port));
  if (connection.key) args.push('-i', quotePowerShellArg(connection.key));
  const target = `${connection.user ? `${connection.user}@` : ''}${connection.host}`;
  args.push(quotePowerShellArg(target));
  return `ssh ${args.join(' ')}`;
}

function openSshConnection(connection) {
  const error = validateSshConnection(connection);
  if (error) { toast(error); return; }
  addBeside(sshLeaf(connection));
  render();
}

function savedItems(isSsh) {
  return isSsh ? state.ssh.connections : state.commands.items;
}

function sortSshFavorites() {
  state.ssh.connections.sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)));
}

function moveSavedItem(isSsh, sourceId, targetId, after) {
  const items = savedItems(isSsh);
  const from = items.findIndex((item) => item.id === sourceId);
  const to = items.findIndex((item) => item.id === targetId);
  if (from < 0 || to < 0 || from === to) return false;
  // Favorites keep their own group at the top; reordering never toggles a star.
  if (isSsh && Boolean(items[from].favorite) !== Boolean(items[to].favorite)) return false;
  let insertion = to + Number(after);
  const [item] = items.splice(from, 1);
  if (from < insertion) insertion -= 1;
  items.splice(insertion, 0, item);
  return true;
}

function renderSavedList(isSsh) {
  const kind = isSsh ? 'ssh' : 'command';
  const group = isSsh ? state.ssh : state.commands;
  const section = $(`#${kind}-section`);
  section.classList.toggle('collapsed', group.collapsed);
  const list = $(`#${kind}-list`);
  list.replaceChildren();
  if (isSsh) sortSshFavorites();
  const items = savedItems(isSsh);
  if (!items.length) {
    const empty = document.createElement('button');
    empty.className = 'ssh-empty';
    empty.textContent = `＋ ${isSsh ? '접속' : '명령어'} 등록`;
    empty.onclick = () => isSsh ? openSshDialog() : openCommandDialog();
    list.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `ssh-item${isSsh ? '' : ' command-item'}`;
    row.draggable = true;
    row.ondragstart = (event) => {
      draggedSavedItem = { isSsh, id: item.id };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', item.id);
    };
    row.ondragend = () => {
      draggedSavedItem = null;
      document.querySelectorAll('.saved-drop-before, .saved-drop-after').forEach((element) =>
        element.classList.remove('saved-drop-before', 'saved-drop-after'));
    };
    row.ondragover = (event) => {
      if (!draggedSavedItem || draggedSavedItem.isSsh !== isSsh || draggedSavedItem.id === item.id) return;
      const source = items.find((entry) => entry.id === draggedSavedItem.id);
      if (!source || (isSsh && Boolean(source.favorite) !== Boolean(item.favorite))) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const after = event.clientY >= rect.top + rect.height / 2;
      row.classList.toggle('saved-drop-before', !after);
      row.classList.toggle('saved-drop-after', after);
    };
    row.ondragleave = (event) => {
      if (!row.contains(event.relatedTarget)) row.classList.remove('saved-drop-before', 'saved-drop-after');
    };
    row.ondrop = (event) => {
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove('saved-drop-before', 'saved-drop-after');
      if (!draggedSavedItem || draggedSavedItem.isSsh !== isSsh) return;
      const rect = row.getBoundingClientRect();
      const moved = moveSavedItem(isSsh, draggedSavedItem.id, item.id, event.clientY >= rect.top + rect.height / 2);
      draggedSavedItem = null;
      if (moved) { persist(); renderSavedList(isSsh); }
    };
    const run = document.createElement('button');
    run.className = 'ssh-connect';
    run.title = isSsh ? buildSshCommand(item) : item.value;
    run.innerHTML = `<span class="ssh-item-icon${isSsh ? '' : ' command-item-icon'}">${isSsh ? '↗' : '›_'}</span><span class="ssh-item-copy"><span class="ssh-item-name"></span><span class="ssh-item-host"></span></span>`;
    run.querySelector('.ssh-item-name').textContent = item.name;
    run.querySelector('.ssh-item-host').textContent = isSsh
      ? `${item.user ? `${item.user}@` : ''}${item.host}${item.port ? `:${item.port}` : ''}`
      : item.value.replace(/\s+/g, ' ');
    run.onclick = () => isSsh ? openSshConnection(item) : runSavedCommand(item);
    const edit = document.createElement('button');
    edit.className = 'ssh-edit';
    edit.textContent = '•••';
    edit.title = `${isSsh ? 'SSH 접속' : '명령어'} 편집`;
    edit.onclick = () => isSsh ? openSshDialog(item) : openCommandDialog(item);
    row.append(run);
    if (isSsh) {
      const favorite = document.createElement('button');
      favorite.className = `ssh-favorite${item.favorite ? ' selected' : ''}`;
      favorite.textContent = item.favorite ? '★' : '☆';
      favorite.title = item.favorite ? '즐겨찾기 해제' : '즐겨찾기 추가';
      favorite.setAttribute('aria-label', favorite.title);
      favorite.setAttribute('aria-pressed', String(Boolean(item.favorite)));
      favorite.onclick = (event) => {
        event.stopPropagation();
        item.favorite = !item.favorite;
        sortSshFavorites();
        persist();
        renderSavedList(true);
      };
      row.append(favorite);
    }
    row.append(edit);
    list.append(row);
  }
}

function openSshDialog(connection = null) {
  $('#ssh-id').value = connection?.id || '';
  $('#ssh-name').value = connection?.name || '';
  $('#ssh-host').value = connection?.host || '';
  $('#ssh-user').value = connection?.user || '';
  $('#ssh-port').value = connection?.port || '';
  $('#ssh-key').value = connection?.key || '';
  $('#ssh-password').value = '';
  $('#ssh-password').placeholder = connection?.passwordSaved ? '저장된 비밀번호 유지' : 'Windows 보안 저장소에 암호화';
  $('#ssh-clear-password').checked = false;
  $('#clear-password-row').hidden = !connection?.passwordSaved;
  $('#ssh-form-error').textContent = '';
  $('#delete-ssh').hidden = !connection;
  $('#ssh-dialog-title').textContent = connection ? 'Edit SSH connection' : 'New SSH connection';
  $('#ssh-modal').hidden = false;
  requestAnimationFrame(() => $('#ssh-name').focus());
}

function closeSshDialog() { $('#ssh-modal').hidden = true; $('#ssh-password').value = ''; }

function readSshForm() {
  return {
    id: $('#ssh-id').value || uid('ssh'),
    name: $('#ssh-name').value.trim(),
    host: $('#ssh-host').value.trim(),
    user: $('#ssh-user').value.trim(),
    port: $('#ssh-port').value.trim(),
    key: $('#ssh-key').value.trim(),
    passwordSaved: false,
    _password: $('#ssh-password').value,
    _clearPassword: $('#ssh-clear-password').checked,
  };
}

function runSavedCommand(command) {
  const leaf = findLeaf(activeWorkspace()?.root, state.activePaneId);
  if (!leaf || leaf.type !== 'terminal') { toast('먼저 명령을 입력할 터미널을 선택하세요.'); return; }
  const data = command.value.replace(/\r?\n/g, '\r') + (command.run ? '\r' : '');
  terminalRequest(leaf, 'write', { data }).catch((error) => toast(error.message));
  terminalViews.get(leaf.sessionId)?.terminal.focus();
}

function terminalRequest(leaf, method, params) {
  const request = () => window.cmux.terminal.request(method, { id: leaf.sessionId, ...params });
  return Promise.resolve(terminalViews.get(leaf.sessionId)?.ready)
    .then(request)
    .catch(async (error) => {
      if (!['write', 'resize'].includes(method) || !/(세션을 찾을 수 없습니다|session.*not found)/i.test(error.message)) throw error;
      await window.cmux.terminal.request('create', { id: leaf.sessionId, shell: 'powershell.exe' });
      return request();
    });
}

function openCommandDialog(command = null) {
  $('#command-id').value = command?.id || '';
  $('#command-name').value = command?.name || '';
  $('#command-value').value = command?.value || '';
  $('#command-run').checked = command?.run ?? true;
  $('#command-form-error').textContent = '';
  $('#delete-command').hidden = !command;
  $('#command-dialog-title').textContent = command ? 'Edit command' : 'New command';
  $('#command-modal').hidden = false;
  requestAnimationFrame(() => $('#command-name').focus());
}

function closeCommandDialog() { $('#command-modal').hidden = true; }

function readCommandForm() {
  return {
    id: $('#command-id').value || uid('command'),
    name: $('#command-name').value.trim(),
    value: $('#command-value').value.trim(),
    run: $('#command-run').checked,
  };
}

function renderWorkspaceMenu(workspace, row, menuButton) {
  const menu = document.createElement('div');
  menu.className = 'workspace-menu';
  const rename = document.createElement('button');
  rename.textContent = '이름 변경';
  rename.onclick = (event) => {
    event.stopPropagation();
    showWorkspaceRenameEditor(workspace, menu);
  };
  const editNote = document.createElement('button');
  editNote.textContent = '메모 편집';
  editNote.onclick = (event) => {
    event.stopPropagation();
    menu.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'note-editor-heading';
    heading.textContent = '워크스페이스 메모';
    const textarea = document.createElement('textarea');
    textarea.className = 'workspace-note-editor';
    textarea.value = workspace.note === '~' ? '' : workspace.note;
    textarea.placeholder = '워크스페이스 아래에 표시할 메모';
    const actions = document.createElement('div');
    actions.className = 'note-editor-actions';
    const cancel = document.createElement('button');
    cancel.textContent = '취소';
    const save = document.createElement('button');
    save.textContent = '저장';
    save.className = 'note-save';
    cancel.onclick = () => { openWorkspaceMenuId = null; renderSidebar(); };
    const commit = () => { workspace.note = textarea.value.trim() || '~'; openWorkspaceMenuId = null; render(); };
    save.onclick = commit;
    textarea.onkeydown = (keyEvent) => {
      keyEvent.stopPropagation();
      if (keyEvent.key === 'Enter' && keyEvent.ctrlKey) commit();
      if (keyEvent.key === 'Escape') { openWorkspaceMenuId = null; renderSidebar(); }
    };
    actions.append(cancel, save);
    menu.append(heading, textarea, actions);
    textarea.focus();
  };
  const remove = document.createElement('button');
  remove.className = 'workspace-delete-action';
  remove.textContent = '워크스페이스 삭제';
  remove.onclick = (event) => {
    event.stopPropagation();
    if (!confirm(`'${workspace.name}' 워크스페이스와 포함된 터미널을 삭제할까요?`)) return;
    deleteWorkspace(workspace.id);
  };
  const colors = document.createElement('div');
  colors.className = 'color-picker';
  for (const color of ['#5b8cff', '#56c596', '#e69c55', '#e26472', '#b777e8', '#51b9cc']) {
    const swatch = document.createElement('button');
    swatch.className = `color-swatch${workspace.color === color ? ' selected' : ''}`;
    swatch.style.background = color;
    swatch.title = color;
    swatch.onclick = (event) => { event.stopPropagation(); workspace.color = color; workspace.icon = ''; openWorkspaceMenuId = null; render(); };
    colors.append(swatch);
  }
  const editIcon = document.createElement('button');
  editIcon.className = 'workspace-icon-action';
  editIcon.textContent = workspace.icon ? '아이콘 변경' : '아이콘 추가';
  editIcon.onclick = (event) => {
    event.stopPropagation();
    menu.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'note-editor-heading';
    heading.textContent = '워크스페이스 아이콘';
    const hint = document.createElement('div');
    hint.className = 'icon-editor-hint';
    hint.textContent = '이모지 또는 짧은 문자 1~2개';
    const input = document.createElement('input');
    input.className = 'workspace-icon-editor';
    input.value = workspace.icon;
    input.placeholder = '예: 🚀, DEV, ⚡';
    const presets = document.createElement('div');
    presets.className = 'icon-presets';
    for (const icon of ['🚀', '💻', '⚡', '🛠', '🌐', '📦']) {
      const preset = document.createElement('button');
      preset.textContent = icon;
      preset.onclick = () => { input.value = icon; };
      presets.append(preset);
    }
    const actions = document.createElement('div');
    actions.className = 'note-editor-actions';
    const clear = document.createElement('button');
    clear.textContent = '아이콘 제거';
    const save = document.createElement('button');
    save.className = 'note-save';
    save.textContent = '저장';
    clear.onclick = () => { workspace.icon = ''; openWorkspaceMenuId = null; render(); };
    const commit = () => {
      workspace.icon = limitIcon(input.value.trim());
      openWorkspaceMenuId = null;
      render();
    };
    save.onclick = commit;
    input.onkeydown = (keyEvent) => {
      keyEvent.stopPropagation();
      if (keyEvent.key === 'Enter') commit();
      if (keyEvent.key === 'Escape') { openWorkspaceMenuId = null; renderSidebar(); }
    };
    actions.append(clear, save);
    menu.append(heading, hint, input, presets, actions);
    input.focus();
    input.select();
  };
  menu.append(rename, editNote, remove, colors, editIcon);
  row.append(menu);
  menuButton.classList.add('open');
}

function showWorkspaceRenameEditor(workspace, menu) {
  menu.replaceChildren();
  const heading = document.createElement('div');
  heading.className = 'note-editor-heading';
  heading.textContent = '워크스페이스 이름';
  const input = document.createElement('input');
  input.className = 'workspace-icon-editor workspace-rename-editor';
  input.value = workspace.name;
  input.maxLength = 64;
  const actions = document.createElement('div');
  actions.className = 'note-editor-actions';
  const cancel = document.createElement('button');
  cancel.textContent = '취소';
  const save = document.createElement('button');
  save.className = 'note-save';
  save.textContent = '저장';
  const close = () => { openWorkspaceMenuId = null; renderSidebar(); };
  const commit = () => {
    const name = input.value.trim();
    if (!name) { input.classList.add('invalid'); input.focus(); return; }
    workspace.name = name;
    openWorkspaceMenuId = null;
    render();
  };
  cancel.onclick = close;
  save.onclick = commit;
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') close();
  };
  actions.append(cancel, save);
  menu.append(heading, input, actions);
  input.focus();
  input.select();
}

function limitIcon(value) {
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].slice(0, 2).map(({ segment }) => segment).join('');
}

function deleteWorkspace(workspaceId) {
  const index = state.workspaces.findIndex((workspace) => workspace.id === workspaceId);
  if (index === -1) return;
  const [removed] = state.workspaces.splice(index, 1);
  for (const leaf of collectLeaves(removed.root)) {
    if (leaf.type === 'terminal') window.cmux.terminal.request('close', { id: leaf.sessionId }).catch(() => {});
  }
  if (!state.workspaces.length) {
    const root = terminalLeaf();
    state.workspaces.push({ id: uid('ws'), name: 'Workspace 1', note: '~', icon: '', color: '#5b8cff', root });
  }
  if (state.activeWorkspaceId === workspaceId) {
    const next = state.workspaces[Math.min(index, state.workspaces.length - 1)];
    state.activeWorkspaceId = next.id;
    state.activePaneId = firstLeaf(next.root)?.id || null;
  }
  openWorkspaceMenuId = null;
  render();
}

function renderSidebar() {
  renderSavedList(true);
  renderSavedList(false);
  const list = $('#workspace-list');
  list.replaceChildren();
  for (const workspace of state.workspaces) {
    const row = document.createElement('div');
    row.className = 'workspace-row';
    row.dataset.workspaceId = workspace.id;
    row.ondragover = (event) => {
      if (!draggedWorkspaceId || draggedWorkspaceId === workspace.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      row.classList.toggle('workspace-drop-before', event.clientY < rect.top + rect.height / 2);
      row.classList.toggle('workspace-drop-after', event.clientY >= rect.top + rect.height / 2);
      row.classList.add('workspace-drag-over');
    };
    row.ondragleave = (event) => {
      if (!row.contains(event.relatedTarget)) row.classList.remove('workspace-drag-over', 'workspace-drop-before', 'workspace-drop-after');
    };
    row.ondrop = (event) => {
      if (!draggedWorkspaceId) return;
      event.preventDefault();
      event.stopPropagation();
      row.classList.remove('workspace-drag-over', 'workspace-drop-before', 'workspace-drop-after');
      const sourceIndex = state.workspaces.findIndex((item) => item.id === draggedWorkspaceId);
      const targetIndex = state.workspaces.findIndex((item) => item.id === workspace.id);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
      const midpoint = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
      let insertionIndex = targetIndex + (event.clientY >= midpoint ? 1 : 0);
      const [moved] = state.workspaces.splice(sourceIndex, 1);
      if (sourceIndex < insertionIndex) insertionIndex -= 1;
      state.workspaces.splice(insertionIndex, 0, moved);
      draggedWorkspaceId = null;
      saveState();
      renderSidebar();
    };
    const button = document.createElement('button');
    button.className = `workspace-item${workspace.id === state.activeWorkspaceId ? ' active' : ''}`;
    button.draggable = true;
    button.ondragstart = (event) => {
      draggedWorkspaceId = workspace.id;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', workspace.id);
    };
    button.ondragend = () => {
      draggedWorkspaceId = null;
      document.querySelectorAll('.workspace-drag-over').forEach((item) => item.classList.remove('workspace-drag-over', 'workspace-drop-before', 'workspace-drop-after'));
    };
    const paneCount = countLeaves(workspace.root);
    button.innerHTML = `<span class="workspace-dot"></span><span class="workspace-copy"><span class="workspace-name"></span><span class="workspace-preview"><span class="workspace-note"></span><span>:${paneCount} panes</span></span></span><span class="workspace-count">${paneCount}</span>`;
    button.title = `${workspace.name} · 드래그해 순서 변경`;
    const marker = button.querySelector('.workspace-dot');
    marker.style.background = workspace.color;
    if (workspace.icon) {
      marker.classList.add('has-icon');
      marker.style.background = 'transparent';
      marker.textContent = workspace.icon;
    }
    button.querySelector('.workspace-name').textContent = workspace.name;
    button.querySelector('.workspace-note').textContent = workspace.note;
    button.onclick = () => {
      if (state.activeWorkspaceId === workspace.id) return;
      maximizedPaneId = null;
      state.activeWorkspaceId = workspace.id;
      state.activePaneId = firstLeaf(workspace.root)?.id || null;
      render();
    };
    button.ondblclick = (event) => {
      event.stopPropagation();
      openWorkspaceMenuId = workspace.id;
      renderSidebar();
      const editorMenu = document.querySelector(`.workspace-row[data-workspace-id="${workspace.id}"] .workspace-menu`);
      if (editorMenu) showWorkspaceRenameEditor(workspace, editorMenu);
    };
    const menuButton = document.createElement('button');
    menuButton.className = 'workspace-menu-button';
    menuButton.textContent = '⋮';
    menuButton.title = '워크스페이스 메뉴';
    menuButton.onclick = (event) => {
      event.stopPropagation();
      openWorkspaceMenuId = openWorkspaceMenuId === workspace.id ? null : workspace.id;
      renderSidebar();
    };
    row.append(button, menuButton);
    if (openWorkspaceMenuId === workspace.id) renderWorkspaceMenu(workspace, row, menuButton);
    list.append(row);
  }
  $('#workspace-title').textContent = activeWorkspace()?.name || '';
}

function render() {
  persist();
  const shell = document.querySelector('.app-shell');
  shell.classList.toggle('sidebar-collapsed', state.sidebar.collapsed);
  shell.style.setProperty('--sidebar-width', `${state.sidebar.width}px`);
  renderSidebar();
  const workspace = activeWorkspace();
  const liveSessions = new Set(state.workspaces.flatMap(({ root }) =>
    collectLeaves(root).filter((leaf) => leaf.type === 'terminal').map((leaf) => leaf.sessionId)
  ));
  for (const [sessionId, view] of terminalViews) {
    if (liveSessions.has(sessionId)) continue;
    view.terminal.dispose();
    terminalViews.delete(sessionId);
  }
  stage.replaceChildren();
  if (!workspace?.root) {
    stage.innerHTML = '<div class="empty-state"><div class="empty-card"><h2>빈 워크스페이스</h2><p>왼쪽 아래에서 터미널이나 브라우저를 추가하세요.</p></div></div>';
    return;
  }
  const maximizedLeaf = maximizedPaneId ? findLeaf(workspace.root, maximizedPaneId) : null;
  if (maximizedPaneId && !maximizedLeaf) maximizedPaneId = null;
  stage.classList.toggle('pane-maximized', Boolean(maximizedLeaf));
  stage.append(maximizedLeaf ? renderPane(maximizedLeaf) : renderNode(workspace.root));
}

function renderNode(node) {
  if (node.kind !== 'split') return renderPane(node);
  const split = document.createElement('div');
  split.className = `split ${node.direction}`;
  const first = document.createElement('div');
  const second = document.createElement('div');
  const divider = document.createElement('div');
  first.className = second.className = 'split-child';
  divider.className = 'divider';
  first.style.flex = `${node.ratio} 1 0`;
  second.style.flex = `${1 - node.ratio} 1 0`;
  first.append(renderNode(node.first));
  second.append(renderNode(node.second));
  divider.onpointerdown = (event) => startResize(event, node, split, divider);
  split.append(first, divider, second);
  return split;
}

function startResize(event, node, split, divider) {
  event.preventDefault();
  divider.setPointerCapture(event.pointerId);
  divider.classList.add('dragging');
  divider.onpointermove = (move) => {
    const rect = split.getBoundingClientRect();
    const raw = node.direction === 'row' ? (move.clientX - rect.left) / rect.width : (move.clientY - rect.top) / rect.height;
    node.ratio = Math.max(0.12, Math.min(0.88, raw));
    split.children[0].style.flex = `${node.ratio} 1 0`;
    split.children[2].style.flex = `${1 - node.ratio} 1 0`;
    fitAll();
  };
  divider.onpointerup = divider.onpointercancel = () => { divider.classList.remove('dragging'); divider.onpointermove = null; persist(); };
}

function identifyShell(shell = '') {
  const executable = shell.toLowerCase();
  if (executable.includes('powershell') || executable.includes('pwsh')) return 'powershell';
  if (executable.includes('cmd')) return 'cmd';
  if (executable.includes('ssh')) return 'ssh';
  return 'terminal';
}

function applyShellPresentation(leaf, pane, shellType, terminalTitle) {
  leaf.shellType = shellType;
  const presentation = SHELL_PRESENTATION[shellType] || SHELL_PRESENTATION.terminal;
  if (!leaf.titleCustomized) leaf.title = terminalTitle || presentation.title;
  pane?.querySelector('.type-icon')?.replaceChildren(document.createTextNode(presentation.icon));
  const title = pane?.querySelector('.pane-title');
  if (title) title.textContent = leaf.title;
  persist();
}

function renderPane(leaf) {
  const pane = document.createElement('section');
  pane.className = `pane${state.activePaneId === leaf.id ? ' active' : ''}`;
  pane.dataset.paneId = leaf.id;
  const isMaximized = maximizedPaneId === leaf.id;
  pane.innerHTML = `<div class="pane-header"><div class="pane-tab" draggable="true"><span class="type-icon"></span><span class="pane-title"></span></div><button class="pane-action pane-maximize-action" title="${isMaximized ? '패널 복원' : '패널 확대'}">${isMaximized ? '❐' : '⛶'}</button><button class="pane-action" title="닫기">×</button></div><div class="pane-content"></div><div class="drop-overlay"><div class="layout-preview"></div></div>`;
  pane.querySelector('.type-icon').textContent = leaf.type === 'browser' ? '◎' : (SHELL_PRESENTATION[leaf.shellType] || SHELL_PRESENTATION.terminal).icon;
  pane.querySelector('.pane-title').textContent = leaf.title;
  pane.onpointerdown = () => { state.activePaneId = leaf.id; document.querySelectorAll('.pane.active').forEach((item) => item.classList.remove('active')); pane.classList.add('active'); persist(); };
  pane.querySelector('.pane-maximize-action').onclick = (event) => { event.stopPropagation(); maximizedPaneId = isMaximized ? null : leaf.id; state.activePaneId = leaf.id; render(); };
  pane.querySelector('.pane-action:last-of-type').onclick = (event) => { event.stopPropagation(); closePane(leaf); };
  const tab = pane.querySelector('.pane-tab');
  tab.ondragstart = (event) => { draggedLeafId = leaf.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', leaf.id); };
  tab.ondblclick = (event) => {
    event.stopPropagation();
    tab.draggable = false;
    beginInlineRename(pane.querySelector('.pane-title'), leaf.title, (name) => { leaf.title = name; leaf.titleCustomized = true; render(); });
  };
  tab.ondragend = () => {
    draggedLeafId = null;
    currentDropEdge = null;
    document.querySelectorAll('.drag-over').forEach((item) => item.classList.remove('drag-over'));
  };
  pane.ondragover = (event) => {
    if (!draggedLeafId || draggedLeafId === leaf.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = pane.getBoundingClientRect();
    const distances = {
      left: (event.clientX - rect.left) / rect.width,
      right: (rect.right - event.clientX) / rect.width,
      top: (event.clientY - rect.top) / rect.height,
      bottom: (rect.bottom - event.clientY) / rect.height,
    };
    const edge = Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0];
    if (currentDropEdge !== edge || !pane.classList.contains('drag-over')) updateDropPreview(pane, leaf, edge);
  };
  pane.ondragleave = (event) => {
    if (!pane.contains(event.relatedTarget)) { pane.classList.remove('drag-over'); currentDropEdge = null; }
  };
  pane.ondrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const edge = pane.dataset.dropEdge || 'right';
    movePane(draggedLeafId, leaf.id, edge);
  };
  const content = pane.querySelector('.pane-content');
  if (leaf.type === 'terminal') {
    const ready = mountTerminal(leaf, content);
    const view = terminalViews.get(leaf.sessionId);
    if (view) view.ready = ready;
  }
  else mountBrowser(leaf, content);
  return pane;
}

function updateDropPreview(pane, targetLeaf, edge) {
  currentDropEdge = edge;
  pane.dataset.dropEdge = edge;
  pane.classList.add('drag-over');
  document.querySelectorAll('.pane.drag-over').forEach((item) => { if (item !== pane) item.classList.remove('drag-over'); });
  const source = findLeaf(activeWorkspace().root, draggedLeafId);
  const preview = pane.querySelector('.layout-preview');
  const vertical = edge === 'top' || edge === 'bottom';
  const movingFirst = edge === 'left' || edge === 'top';
  preview.className = `layout-preview${vertical ? ' column' : ''}`;
  const makePreview = (title, moving = false) => {
    const item = document.createElement('div');
    item.className = `preview-pane${moving ? ' moving' : ''}`;
    const label = document.createElement('span');
    label.textContent = title;
    item.append(label);
    return item;
  };
  const target = makePreview(targetLeaf.title);
  const moving = makePreview(source?.title || '이동할 패널', true);
  preview.replaceChildren(...(movingFirst ? [moving, target] : [target, moving]));
}

async function mountTerminal(leaf, content) {
  const existing = terminalViews.get(leaf.sessionId);
  if (existing) {
    existing.leaf = leaf;
    content.append(existing.element);
    fitAll();
    return existing.ready;
  }
  const host = document.createElement('div');
  host.className = 'terminal-host';
  content.append(host);
  const terminal = new Terminal({
    cursorBlink: true, fontFamily: 'Cascadia Code, Consolas, "Malgun Gothic", monospace', fontSize: state.settings.terminalFontSize,
    theme: { background: '#292d35', foreground: '#e2e5ea', cursor: '#b8c7ff', selectionBackground: '#6884bd66', black: '#1c2026' },
    allowProposedApi: false, scrollback: 100000
  });
  let replaying = false;
  const writeClipboardFromOsc52 = (data) => {
    if (replaying) return true;
    const separator = data.indexOf(';');
    if (separator < 0) return false;
    const selection = data.slice(0, separator);
    const encoded = data.slice(separator + 1);
    if (!/^[cp0-7]*$/.test(selection) || encoded === '?' || encoded.length > 134_000) return false;
    try {
      const binary = atob(encoded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      if (bytes.length > 100_000) return false;
      const text = new TextDecoder().decode(bytes);
      window.cmux.clipboard.writeText(text).catch((error) => toast(error.message));
      return true;
    } catch (_) {
      return false;
    }
  };
  terminal.parser.registerOscHandler(52, writeClipboardFromOsc52);
  terminal.parser.registerDcsHandler({ final: 't' }, (data) => {
    if (!data.startsWith('mux;')) return false;
    const passthrough = data.slice(4).replace(/\x1b\x1b/g, '\x1b');
    const match = passthrough.match(/\x1b\]52;([cp0-7]*);([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/);
    return match ? writeClipboardFromOsc52(`${match[1]};${match[2]}`) : false;
  });
  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon((event, uri) => {
    if (!event.ctrlKey) { toast('Ctrl+클릭으로 기본 브라우저에서 링크 열기'); return; }
    window.cmux.external.openUrl(uri).catch((error) => toast(error.message));
  });
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinksAddon);
  terminal.open(host);
  terminal.onSelectionChange(() => {
    if (terminal.hasSelection()) copyTerminalSelection(terminal);
  });
  terminal.attachCustomKeyEventHandler((event) => handleTerminalKey(event, terminal));
  terminalViews.set(leaf.sessionId, { terminal, fitAddon, element: host, leaf, promptTail: '', passwordAttempted: false, passwordDeadline: Date.now() + 30000 });
  const isCurrent = () => terminalViews.get(leaf.sessionId)?.terminal === terminal;
  terminal.onData((data) => terminalRequest(leaf, 'write', { data }).catch((error) => toast(error.message)));
  terminal.onResize(({ cols, rows }) => terminalRequest(leaf, 'resize', { cols, rows }).catch(() => {}));
  terminal.onTitleChange((title) => {
    if (!isCurrent()) return;
    const currentLeaf = terminalViews.get(leaf.sessionId).leaf;
    if (/[^\s]+@[^\s]+/.test(title)) applyShellPresentation(currentLeaf, host.closest('.pane'), 'ssh', title);
    else if (currentLeaf.shellType === 'ssh') applyShellPresentation(currentLeaf, host.closest('.pane'), currentLeaf.baseShellType || 'terminal');
  });
  try {
    const sessions = await window.cmux.terminal.request('list');
    if (!isCurrent()) return;
    await window.cmux.terminal.request('create', { id: leaf.sessionId, shell: 'powershell.exe' });
    if (!sessions.some(({ id }) => id === leaf.sessionId)) leaf.commandSent = false;
    if (!isCurrent()) return;
    const attached = await window.cmux.terminal.request('attach', { id: leaf.sessionId });
    if (!isCurrent()) return;
    const baseShellType = identifyShell(attached.shell);
    leaf.baseShellType = baseShellType;
    applyShellPresentation(leaf, host.closest('.pane'), leaf.pendingCommand ? (leaf.shellType || 'ssh') : baseShellType);
    if (attached.buffer) {
      replaying = true;
      terminal.write(attached.buffer, () => { replaying = false; });
    }
    if (leaf.pendingCommand && !leaf.commandSent) {
      leaf.commandSent = true;
      persist();
      try { await window.cmux.terminal.request('write', { id: leaf.sessionId, data: `${leaf.pendingCommand}\r` }); }
      catch (error) { leaf.commandSent = false; throw error; }
    }
    fitAll();
  } catch (error) { if (isCurrent()) terminal.writeln(`\r\n\x1b[31mcmux: ${error.message}\x1b[0m`); }
}

function copyTerminalSelection(terminal) {
  window.cmux.clipboard.writeText(terminal.getSelection()).catch((error) => toast(error.message));
}

function handleTerminalKey(event, terminal) {
  if (executeShortcut(event)) return false;
  if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    terminal.input('\n', true);
    return false;
  }
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
  const key = event.key.toLowerCase();
  if (key === 'c' && terminal.hasSelection()) {
    copyTerminalSelection(terminal);
    return false;
  }
  if (key === 'c' && event.shiftKey) return false;
  if (key === 'v') {
    event.preventDefault();
    event.stopPropagation();
    window.cmux.clipboard.readText().then((text) => {
      if (text) terminal.paste(text);
    }).catch((error) => toast(error.message));
    return false;
  }
  return true;
}

function normalizeUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return 'https://www.google.com';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.includes('.') && !trimmed.includes(' ')) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function mountBrowser(leaf, content) {
  const toolbar = document.createElement('div');
  toolbar.className = 'browser-toolbar';
  toolbar.innerHTML = '<button title="뒤로">←</button><button title="앞으로">→</button><button title="새로고침">↻</button><input class="url-input" aria-label="주소" />';
  const webview = document.createElement('webview');
  leaf.url = normalizeUrl(leaf.url);
  webview.src = leaf.url;
  const [back, forward, reload] = toolbar.querySelectorAll('button');
  const input = toolbar.querySelector('input');
  input.value = leaf.url;
  back.onclick = () => webview.canGoBack() && webview.goBack();
  forward.onclick = () => webview.canGoForward() && webview.goForward();
  reload.onclick = () => webview.reload();
  input.onkeydown = (event) => { if (event.key === 'Enter') { leaf.url = normalizeUrl(input.value); webview.loadURL(leaf.url); persist(); } };
  webview.addEventListener('did-navigate', (event) => { leaf.url = event.url; input.value = event.url; persist(); });
  webview.addEventListener('page-title-updated', (event) => { leaf.title = event.title || 'Browser'; const pane = content.closest('.pane'); if (pane) pane.querySelector('.pane-title').textContent = leaf.title; persist(); });
  content.append(toolbar, webview);
}

function closePane(leaf) {
  const workspace = activeWorkspace();
  workspace.root = removeLeaf(workspace.root, leaf.id);
  if (leaf.type === 'terminal') window.cmux.terminal.request('close', { id: leaf.sessionId }).catch(() => {});
  if (maximizedPaneId === leaf.id) maximizedPaneId = null;
  state.activePaneId = firstLeaf(workspace.root)?.id || null;
  render();
}

function movePane(sourceId, targetId, edge) {
  if (!sourceId || sourceId === targetId) return;
  const workspace = activeWorkspace();
  const source = findLeaf(workspace.root, sourceId);
  if (!source) return;
  const target = findLeaf(workspace.root, targetId);
  if (!target) return;
  workspace.root = removeLeaf(workspace.root, sourceId);
  addBeside(source, targetId, edge);
  render();
}

function fitAll() {
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    for (const { fitAddon, element } of terminalViews.values()) {
      if (!element.isConnected) continue;
      try { fitAddon.fit(); } catch (_) {}
    }
  });
}

window.cmux.terminal.onEvent((message) => {
  if (message.event === 'data') {
    const view = terminalViews.get(message.sessionId);
    view?.terminal.write(message.data);
    maybeSendSshPassword(view, message.data);
  }
  if (message.event === 'exit') {
    const view = terminalViews.get(message.sessionId);
    if (!view) return;
    view.terminal.writeln(`\r\n\x1b[33m[프로세스 종료: ${message.exitCode} · 재시작 중]\x1b[0m`);
    view.leaf.commandSent = false;
    window.cmux.terminal.request('create', { id: message.sessionId, shell: 'powershell.exe' }).catch((error) => toast(error.message));
  }
});

async function maybeSendSshPassword(view, data) {
  if (!view?.leaf.autoPassword || view.passwordAttempted || Date.now() > view.passwordDeadline) return;
  view.promptTail = (view.promptTail + data).slice(-256);
  if (!/password:\s*$/i.test(view.promptTail)) return;
  view.passwordAttempted = true;
  const password = await window.cmux.credentials.get(view.leaf.sshConnectionId).catch(() => '');
  if (!password) return;
  await window.cmux.terminal.request('write', { id: view.leaf.sessionId, data: `${password}\r` }).catch(() => {});
}

function createWorkspace() {
  const workspace = { id: uid('ws'), name: `Workspace ${state.workspaces.length + 1}`, note: '~', icon: '', color: '#5b8cff', root: terminalLeaf() };
  state.workspaces.push(workspace);
  state.activeWorkspaceId = workspace.id;
  maximizedPaneId = null;
  state.activePaneId = workspace.root.id;
  render();
}

function closeActivePane() {
  const leaf = findLeaf(activeWorkspace()?.root, state.activePaneId);
  if (leaf) closePane(leaf);
}

function toggleSidebar() {
  state.sidebar.collapsed = !state.sidebar.collapsed;
  render();
  fitAll();
}

function switchWorkspaceByIndex(index) {
  const workspace = state.workspaces[index];
  if (!workspace) { toast(`${index + 1}번째 워크스페이스가 없습니다.`); return; }
  state.activeWorkspaceId = workspace.id;
  maximizedPaneId = null;
  state.activePaneId = firstLeaf(workspace.root)?.id || null;
  render();
}

function activateNextPane() {
  const now = performance.now();
  if (now - lastPaneSwitchAt < 175) return;
  lastPaneSwitchAt = now;
  const terminals = collectLeaves(activeWorkspace()?.root).filter((leaf) => leaf.type === 'terminal');
  if (terminals.length < 2) return;
  const currentIndex = terminals.findIndex((leaf) => leaf.id === state.activePaneId);
  const next = terminals[(currentIndex + 1 + terminals.length) % terminals.length];
  state.activePaneId = next.id;
  if (maximizedPaneId) { maximizedPaneId = next.id; render(); return; }
  document.querySelectorAll('.pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.paneId === next.id));
  terminalViews.get(next.sessionId)?.terminal.focus();
  persist();
}

function shortcutFromEvent(event) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null;
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  if (event.metaKey) parts.push('Meta');
  let key = event.key;
  if (key === ' ') key = 'Space';
  else if (key === 'Escape') key = 'Esc';
  else if (/^insert$/i.test(key) || event.code === 'Insert' || event.code === 'Numpad0') key = 'Insert';
  else if (key.length === 1 && /[a-z]/i.test(key)) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

function adjustTerminalFontSize(delta) {
  const nextSize = Math.max(10, Math.min(24, state.settings.terminalFontSize + delta));
  if (nextSize === state.settings.terminalFontSize) return;
  state.settings.terminalFontSize = nextSize;
  for (const { terminal, fitAddon } of terminalViews.values()) {
    terminal.options.fontSize = nextSize;
    try { fitAddon.fit(); } catch (_) {}
  }
  persist();
  toast(`터미널 글꼴 ${nextSize}px`);
}

function syncShortcuts() {
  window.cmux.shortcuts.update(inputMode ? { inputMode: 'Ctrl+Insert' } : { ...state.settings.shortcuts, inputMode: 'Ctrl+Insert' });
}

function toggleInputMode() {
  inputMode = !inputMode;
  $('#input-mode-indicator').hidden = !inputMode;
  syncShortcuts();
  toast(`입력 모드 ${inputMode ? '켜짐' : '꺼짐'}`);
}

function executeShortcut(event) {
  if (event.__cmuxHandled || event.type !== 'keydown') return Boolean(event.__cmuxHandled);
  const shortcut = shortcutFromEvent(event);
  if (shortcut === 'Ctrl+Insert') {
    event.__cmuxHandled = true;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) toggleInputMode();
    return true;
  }
  if (inputMode) return false;
  if (document.querySelector('.modal-backdrop:not([hidden])')) return false;
  if (event.ctrlKey && !event.altKey && !event.metaKey && (event.key === '+' || event.key === '=')) {
    event.__cmuxHandled = true;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) adjustTerminalFontSize(1);
    return true;
  }
  if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === '-') {
    event.__cmuxHandled = true;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) adjustTerminalFontSize(-1);
    return true;
  }
  if (!shortcut) return false;
  const action = Object.entries(state.settings.shortcuts).find(([, value]) => value === shortcut)?.[0];
  if (!action) return false;
  event.__cmuxHandled = true;
  event.preventDefault();
  event.stopPropagation();
  if ((action === 'nextPane' || action === 'toggleFullscreen') && event.repeat) return true;
  runShortcutAction(action);
  return true;
}

function runShortcutAction(action) {
  if (/^workspace[1-9]$/.test(action)) {
    switchWorkspaceByIndex(Number(action.slice(-1)) - 1);
    return;
  }
  const actions = {
    splitRight: () => { addBeside(terminalLeaf(), state.activePaneId, 'right'); render(); },
    splitDown: () => { addBeside(terminalLeaf(), state.activePaneId, 'bottom'); render(); },
    closePane: closeActivePane,
    newWorkspace: createWorkspace,
    newBrowser: () => { addBeside(browserLeaf()); render(); },
    nextPane: activateNextPane,
    toggleSidebar,
    openSettings,
    toggleFullscreen: () => window.cmux.window.control('fullscreen'),
  };
  actions[action]?.();
}

function executeShortcutValue(shortcut) {
  if (shortcut === 'Ctrl+Insert') { toggleInputMode(); return; }
  if (inputMode || document.querySelector('.modal-backdrop:not([hidden])')) return;
  const action = Object.entries(state.settings.shortcuts).find(([, value]) => value === shortcut)?.[0];
  if (action) runShortcutAction(action);
}

function renderShortcutSettings() {
  const list = $('#shortcut-list');
  list.replaceChildren();
  for (const [id, name, description] of SHORTCUT_DEFINITIONS) {
    const row = document.createElement('label');
    row.className = 'shortcut-row';
    row.innerHTML = `<div><div class="shortcut-name"></div><div class="shortcut-description"></div></div><input class="shortcut-input" readonly />`;
    row.querySelector('.shortcut-name').textContent = name;
    row.querySelector('.shortcut-description').textContent = description;
    const input = row.querySelector('input');
    input.value = state.settings.shortcuts[id] || '설정 안 됨';
    input.dataset.action = id;
    input.onkeydown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { input.blur(); return; }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        state.settings.shortcuts[id] = '';
        input.value = '설정 안 됨';
        syncShortcuts();
        persist();
        return;
      }
      const value = shortcutFromEvent(event);
      if (!value) return;
      if (value === 'Ctrl+Insert') { toast('Ctrl+Insert는 입력 모드 전환용입니다.'); return; }
      const duplicate = Object.entries(state.settings.shortcuts).find(([otherId, shortcut]) => otherId !== id && shortcut === value);
      if (duplicate) {
        input.classList.add('conflict');
        toast(`이미 사용 중인 단축키입니다: ${value}`);
        setTimeout(() => input.classList.remove('conflict'), 1000);
        return;
      }
      state.settings.shortcuts[id] = value;
      input.value = value;
      syncShortcuts();
      persist();
    };
    list.append(row);
  }
}

function openSettings() {
  renderShortcutSettings();
  $('#settings-modal').hidden = false;
}

function closeSettings() { $('#settings-modal').hidden = true; }

function startSidebarResize(event) {
  if (state.sidebar.collapsed) state.sidebar.collapsed = false;
  const resizer = $('#sidebar-resizer');
  const shell = document.querySelector('.app-shell');
  resizer.setPointerCapture(event.pointerId);
  resizer.classList.add('dragging');
  resizer.onpointermove = (move) => {
    state.sidebar.width = Math.max(160, Math.min(420, move.clientX));
    shell.classList.remove('sidebar-collapsed');
    shell.style.setProperty('--sidebar-width', `${state.sidebar.width}px`);
    fitAll();
  };
  resizer.onpointerup = resizer.onpointercancel = () => { resizer.classList.remove('dragging'); resizer.onpointermove = null; persist(); };
}

$('#title-add-terminal').onclick = () => { addBeside(terminalLeaf()); render(); };
$('#title-add-browser').onclick = () => { addBeside(browserLeaf()); render(); };
$('#title-settings').onclick = openSettings;
$('#title-toggle-sidebar').onclick = toggleSidebar;
$('#toggle-ssh').onclick = () => { state.ssh.collapsed = !state.ssh.collapsed; persist(); renderSavedList(true); };
$('#add-ssh').onclick = () => openSshDialog();
$('#toggle-commands').onclick = () => { state.commands.collapsed = !state.commands.collapsed; persist(); renderSavedList(false); };
$('#add-command').onclick = () => openCommandDialog();
$('#close-ssh-dialog').onclick = closeSshDialog;
$('#cancel-ssh').onclick = closeSshDialog;
$('#ssh-modal').onclick = (event) => { if (event.target === $('#ssh-modal')) closeSshDialog(); };
$('#ssh-form').onsubmit = async (event) => {
  event.preventDefault();
  const connection = readSshForm();
  const error = validateSshConnection(connection);
  if (error) { $('#ssh-form-error').textContent = error; return; }
  const index = state.ssh.connections.findIndex((item) => item.id === connection.id);
  const existing = index === -1 ? null : state.ssh.connections[index];
  try {
    connection.favorite = Boolean(existing?.favorite);
    if (connection._clearPassword) {
      await window.cmux.credentials.delete(connection.id);
      connection.passwordSaved = false;
    } else if (connection._password) {
      await window.cmux.credentials.set(connection.id, connection._password);
      connection.passwordSaved = true;
    } else {
      connection.passwordSaved = Boolean(existing?.passwordSaved);
    }
    delete connection._password;
    delete connection._clearPassword;
    if (index === -1) state.ssh.connections.push(connection);
    else state.ssh.connections[index] = connection;
    closeSshDialog();
    persist();
    renderSavedList(true);
  } catch (saveError) { $('#ssh-form-error').textContent = saveError.message; }
};
$('#delete-ssh').onclick = async () => {
  const id = $('#ssh-id').value;
  const connection = state.ssh.connections.find((item) => item.id === id);
  if (!connection || !confirm(`SSH 접속 '${connection.name}'을 삭제할까요?`)) return;
  await window.cmux.credentials.delete(id).catch(() => {});
  state.ssh.connections = state.ssh.connections.filter((item) => item.id !== id);
  closeSshDialog();
  persist();
  renderSavedList(true);
};
$('#close-command-dialog').onclick = closeCommandDialog;
$('#cancel-command').onclick = closeCommandDialog;
$('#command-modal').onclick = (event) => { if (event.target === $('#command-modal')) closeCommandDialog(); };
$('#command-form').onsubmit = (event) => {
  event.preventDefault();
  const command = readCommandForm();
  if (!command.name || !command.value) { $('#command-form-error').textContent = '이름과 명령어를 모두 입력하세요.'; return; }
  const index = state.commands.items.findIndex((item) => item.id === command.id);
  if (index === -1) state.commands.items.push(command);
  else state.commands.items[index] = command;
  closeCommandDialog();
  persist();
  renderSavedList(false);
};
$('#delete-command').onclick = () => {
  const id = $('#command-id').value;
  const command = state.commands.items.find((item) => item.id === id);
  if (!command || !confirm(`명령어 '${command.name}'을 삭제할까요?`)) return;
  state.commands.items = state.commands.items.filter((item) => item.id !== id);
  closeCommandDialog();
  persist();
  renderSavedList(false);
};
$('#window-close').onclick = () => window.cmux.window.control('close');
$('#window-minimize').onclick = () => window.cmux.window.control('minimize');
$('#window-maximize').onclick = () => window.cmux.window.control('maximize');
document.querySelector('.titlebar').ondblclick = (event) => {
  if (!event.target.closest('.window-no-drag')) window.cmux.window.control('maximize');
};
$('#add-workspace').onclick = createWorkspace;
$('#sidebar-resizer').onpointerdown = startSidebarResize;
$('#close-settings').onclick = closeSettings;
$('#done-settings').onclick = closeSettings;
$('#settings-modal').onclick = (event) => { if (event.target === $('#settings-modal')) closeSettings(); };
$('#reset-shortcuts').onclick = () => {
  state.settings.shortcuts = { ...DEFAULT_SHORTCUTS };
  syncShortcuts();
  renderShortcutSettings();
  persist();
  toast('기본 단축키로 복원했습니다.');
};
document.addEventListener('keydown', executeShortcut, true);
window.cmux.shortcuts.onPressed(executeShortcutValue);
document.addEventListener('pointerdown', (event) => {
  if (openWorkspaceMenuId && !event.target.closest('.workspace-row')) { openWorkspaceMenuId = null; renderSidebar(); }
});
window.addEventListener('resize', fitAll);
state.activePaneId ||= firstLeaf(activeWorkspace()?.root)?.id || null;
syncShortcuts();
render();

})().catch((error) => {
  console.error('cmux renderer startup failed:', error);
  const message = document.createElement('p');
  message.textContent = error.message;
  document.querySelector('#stage').replaceChildren(message);
});
