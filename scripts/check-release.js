const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);

(async () => {

  const root = path.resolve(__dirname, '..');
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  assert(/^\d+\.\d+\.\d+$/.test(pkg.version) && lock.version === pkg.version
    && lock.packages[''].version === pkg.version, 'Package and lockfile release versions must match.');
  assert(pkg.build.files.includes('src/**/*') && !pkg.build.files.includes('**/*'), 'Use an explicit package allowlist.');
  const ignoreRules = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((line) => line.trim());
  for (const rule of ['.env', '.env.*', 'node_modules/', 'release/', '*.exe']) {
    assert(ignoreRules.includes(rule), `Missing private/generated file ignore rule: ${rule}`);
  }
  const hasRepository = fs.existsSync(path.join(root, '.git', 'HEAD'))
    || (fs.existsSync(path.join(root, '.git')) && fs.statSync(path.join(root, '.git')).isFile());
  let temporary;
  let publicFiles;
  try {
    let gitArguments = [];
    if (!hasRepository) {
      fs.mkdirSync(path.join(root, '.env'), { recursive: true });
      temporary = fs.mkdtempSync(path.join(root, '.env', 'git-check-'));
      await run('git', ['init', '--quiet', temporary]);
      gitArguments = [`--git-dir=${path.join(temporary, '.git')}`, `--work-tree=${root}`];
    }
    const excluded = ['.env/profile.json', '.env/cache/example',
      'node_modules/example', 'release/cmux-v1.0.0.exe', '.aws/example', '.codex/example', '.agents/example'];
    const { stdout: ignored } = await run('git', [...gitArguments, 'check-ignore', '--no-index', ...excluded], { cwd: root, encoding: 'utf8' });
    assert(ignored.trim().split('\n').length === excluded.length, 'Private/generated files are not effectively ignored by Git.');
    const { stdout: index } = await run('git', [...gitArguments, 'ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' });
    const tracked = index.split('\0').filter(Boolean);
    assert(!tracked.some((name) => /(^|\/)(\.env(?:\.|\/|$)|node_modules\/|release\/|\.aws\/|\.codex\/|\.agents\/)|(?:^|\/)(profile|ssh-credentials)\.json$|\.(exe|zip|7z|pdb|pem|key|pfx|p12)$/i.test(name)),
      'Remove private data and generated files from the Git index.');
    const { stdout: available } = await run('git', [...gitArguments, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
    publicFiles = [...new Set(available.split('\0').filter(Boolean))].sort();
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }

  for (const relative of publicFiles) {
    const filename = path.join(root, relative);
    assert(!fs.lstatSync(filename).isSymbolicLink(), 'Public source must not contain symlinks.');
    const contents = fs.readFileSync(filename, 'utf8');
    assert(!/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}/.test(contents),
      `Possible secret in ${relative}; inspect locally.`);
    if (filename.endsWith('.js')) await run(process.execPath, ['--check', filename]);
  }
  fs.mkdirSync(path.join(root, '.env'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env', 'upload-files.txt'), publicFiles.join('\n') + '\n', { mode: 0o600 });
  console.log('Release versions, effective Git exclusions, public-file syntax and secret-pattern checks passed. Upload file list: .env/upload-files.txt.');

})().catch((error) => { console.error(error.message); process.exitCode = 1; });
