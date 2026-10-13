const fs = require('node:fs');
const path = require('node:path');

const MAX_PROFILE_BYTES = 4 * 1024 * 1024;

function createPrivateStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = (name) => path.join(directory, name);
  function read(name, fallback = null) {
    try {
      if (fs.statSync(filename(name)).size > MAX_PROFILE_BYTES) throw new Error('설정 파일이 너무 큽니다.');
      return JSON.parse(fs.readFileSync(filename(name), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      // Never silently replace a corrupt private profile with an empty one.
      throw new Error('비공개 설정을 읽을 수 없습니다. 원본 파일을 확인하세요.');
    }
  }
  function write(name, value) {
    const data = JSON.stringify(value);
    if (!data || Buffer.byteLength(data) > MAX_PROFILE_BYTES) throw new Error('설정 파일이 너무 큽니다.');
    const temporary = `${filename(name)}.tmp`;
    try {
      fs.writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, filename(name));
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  return { read, write };
}

module.exports = { createPrivateStore, MAX_PROFILE_BYTES };
