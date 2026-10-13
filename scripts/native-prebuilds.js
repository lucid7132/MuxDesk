const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function validateWindowsPrebuilds(moduleRoot) {
  const directory = path.join(moduleRoot, 'prebuilds', 'win32-x64');
  for (const name of ['conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty.dll',
    'winpty-agent.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']) {
    const filename = path.join(directory, name);
    const bytes = fs.readFileSync(filename);
    assert(bytes.length > 64 && bytes.readUInt16LE(0) === 0x5a4d, `Invalid Windows prebuilt: ${name}`);
    const offset = bytes.readUInt32LE(0x3c);
    assert(offset + 6 <= bytes.length && bytes.readUInt32LE(offset) === 0x00004550, `Invalid PE header: ${name}`);
    assert.equal(bytes.readUInt16LE(offset + 4), 0x8664, `Expected Windows x64 native binary: ${name}`);
  }
  console.log('Required Windows x64 prebuilt native binaries verified; packaged ConPTY execution remains mandatory.');
}

module.exports = { validateWindowsPrebuilds };
