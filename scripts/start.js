const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function findExecutable(root) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const executable = path.join(root, 'release', `cmux-v${version}.exe`);
  return fs.existsSync(executable) ? executable : undefined;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const executable = findExecutable(root);
  if (process.platform !== 'win32') {
    console.error('cmux requires Windows x64. Run the portable EXE or npm start on Windows.');
    process.exitCode = 1;
  } else if (!executable) {
    console.error('Build the application first: npm ci && npm run build. For source development use npm run dev.');
    process.exitCode = 1;
  } else {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const temporary = path.join(process.env.LOCALAPPDATA, 'Temp');
    fs.mkdirSync(temporary, { recursive: true });
    environment.TEMP = temporary;
    environment.TMP = temporary;
    const child = spawn(executable, [], { cwd: path.dirname(executable), env: environment,
      detached: true, stdio: 'ignore' });
    child.on('error', () => { console.error('Could not launch cmux. Check the portable EXE and Windows local temporary directory.'); process.exitCode = 1; });
    child.unref();
  }
}

module.exports = { findExecutable };
