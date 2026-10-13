const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const { NtExecutable, NtExecutableResource, Resource } = require('resedit');

function checkPackage(directory) {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const archive = path.join(directory, 'resources', 'app.asar');
  asar.uncache(archive);
  const files = asar.listPackage(archive).map((name) => name.split(path.sep).join('/'));
  const archivePath = (name) => path.normalize(name);
  assert(!files.some((name) => /(^|\/)(\.env|test|scripts|\.github)(\/|$)|\.(pdb|zip|7z)$/.test(name)), 'Private or development files in the application package.');
  const expected = { ...pkg };
  delete expected.build; delete expected.devDependencies; delete expected.scripts;
  assert.deepEqual(JSON.parse(asar.extractFile(archive, 'package.json')), expected, 'Packaged manifest differs from source.');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const dependency of Object.keys(pkg.dependencies)) {
    const bundled = JSON.parse(asar.extractFile(archive, archivePath(`node_modules/${dependency}/package.json`)));
    assert.equal(bundled.version, lock.packages[`node_modules/${dependency}`].version, `Stale runtime dependency: ${dependency}`);
  }
  function checkSource(directory, prefix = 'src') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) checkSource(path.join(directory, entry.name), name);
      else assert(asar.extractFile(archive, archivePath(name)).equals(fs.readFileSync(path.join(directory, entry.name))), `Stale packaged source: ${name}`);
    }
  }
  checkSource(path.join(root, 'src'));
  for (const name of files) {
    const relative = name.slice(1);
    const info = asar.statFile(archive, archivePath(relative));
    if (!info.files && !info.link && info.integrity) {
      const hash = crypto.createHash('sha256').update(asar.extractFile(archive, archivePath(relative))).digest('hex');
      assert.equal(hash, info.integrity.hash, `Damaged packaged file: ${relative}`);
    }
  }
  const unpacked = path.join(directory, 'resources', 'app.asar.unpacked');
  for (const name of ['src/terminal-daemon.js', 'node_modules/node-pty/lib/index.js',
    'node_modules/node-pty/lib/worker/conoutSocketWorker.js',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node']) {
    assert(fs.existsSync(path.join(unpacked, name)), `Missing daemon runtime: ${name}`);
  }
  assert(fs.readFileSync(path.join(unpacked, 'src/terminal-daemon.js')).equals(fs.readFileSync(path.join(root, 'src/terminal-daemon.js'))));
  for (const name of ['icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
    'v8_context_snapshot.bin', 'snapshot_blob.bin', 'ffmpeg.dll',
    'd3dcompiler_47.dll', 'locales/en-US.pak', 'locales/ko.pak', 'LICENSE.electron.txt', 'LICENSES.chromium.html']) {
    assert(fs.statSync(path.join(directory, name)).size > 0, `Missing Electron runtime: ${name}`);
  }
  for (const name of ['dxcompiler.dll', 'dxil.dll']) assert(fs.statSync(path.join(directory, name)).size > 0, `Missing graphics runtime: ${name}`);
  const executable = NtExecutable.from(fs.readFileSync(path.join(directory, 'cmux.exe')));
  assert.equal(executable.getImageBase() > 0, true);
  const resources = NtExecutableResource.from(executable);
  const version = Resource.VersionInfo.fromEntries(resources.entries)[0];
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  assert.equal(version.fixedInfo.fileVersionMS, major * 65536 + minor);
  assert.equal(version.fixedInfo.fileVersionLS, patch * 65536);
  const entry = resources.entries.find((value) => value.type === 'INTEGRITY' && value.id === 'ELECTRONASAR');
  assert(entry, 'Missing ASAR integrity resource.');
  const hash = crypto.createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
  assert.equal(JSON.parse(Buffer.from(entry.bin).toString()).find((value) => value.file === 'resources\\app.asar').value, hash);
  console.log(`Verified Windows package v${pkg.version}: source, dependencies, native files, version and integrity.`);
}

if (require.main === module) {
  try { checkPackage(path.resolve(__dirname, '..', process.argv[2] || 'release/win-unpacked')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { checkPackage };
