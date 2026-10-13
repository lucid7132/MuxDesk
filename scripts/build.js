const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { validateWindowsPrebuilds } = require('./native-prebuilds');

if (process.platform !== 'win32') {
  console.error('Build the portable EXE on Windows x64 (or use the Windows GitHub Actions workflow).');
  process.exitCode = 1;
} else {
  const root = path.resolve(__dirname, '..');
  validateWindowsPrebuilds(path.join(root, 'node_modules', 'node-pty'));
  const temporary = path.join(root, '.env', 'cache', 'tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const child = spawn(process.execPath, [require.resolve('electron-builder/cli.js'),
    '--win', 'portable', '--x64', '--publish', 'never'], {
    cwd: root, stdio: 'inherit', env: { ...process.env,
      electron_config_cache: path.join(root, '.env', 'cache', 'electron'),
      APP_BUILDER_TMP_DIR: temporary, TMPDIR: temporary, TEMP: temporary, TMP: temporary,
      ELECTRON_BUILDER_CACHE: path.join(root, '.env', 'cache', 'electron-builder') }
  });
  child.on('error', () => { console.error('Could not start electron-builder.'); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}
