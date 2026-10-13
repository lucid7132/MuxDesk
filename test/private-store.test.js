const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPrivateStore, MAX_PROFILE_BYTES } = require('../src/private-store');
const privateRoot = path.join(__dirname, '..', '.env');
fs.mkdirSync(privateRoot, { recursive: true });

test('private profiles round-trip Unicode data without leaving a temporary file', (t) => {
  const directory = fs.mkdtempSync(path.join(privateRoot, 'test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createPrivateStore(directory);
  assert.equal(store.read('profile.json'), null);
  const profile = { commands: { items: [{ name: '테스트', value: 'echo 😀' }] } };
  store.write('profile.json', profile);
  assert.deepEqual(store.read('profile.json'), profile);
  assert.deepEqual(fs.readdirSync(directory), ['profile.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, 'profile.json')).mode & 0o777, 0o600);
});

test('corrupt or oversized profiles fail without overwriting the original', (t) => {
  const directory = fs.mkdtempSync(path.join(privateRoot, 'test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createPrivateStore(directory);
  const filename = path.join(directory, 'profile.json');
  fs.writeFileSync(filename, '{invalid');
  assert.throws(() => store.read('profile.json'), /비공개 설정/);
  assert.throws(() => store.write('profile.json', { value: 'x'.repeat(MAX_PROFILE_BYTES) }), /너무 큽니다/);
  assert.equal(fs.readFileSync(filename, 'utf8'), '{invalid');
  fs.writeFileSync(filename, ' '.repeat(MAX_PROFILE_BYTES + 1));
  assert.throws(() => store.read('profile.json'), /비공개 설정/);
});
