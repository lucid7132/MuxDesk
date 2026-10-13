const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

(async () => {
  const root = path.resolve(__dirname, '..');
  const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
  const get = builderRequire('@electron/get');
  assert.equal(typeof get.downloadArtifact, 'function');
  assert.equal(typeof get.ElectronDownloadCacheMode.ReadWrite, 'number');
  assert.equal(typeof get.ElectronDownloadCacheMode.WriteOnly, 'number');
  // Verify that the builder's compiled module can load the overridden downloader.
  builderRequire('app-builder-lib/out/util/electronGet.js');
  fs.mkdirSync(path.join(root, '.env'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, '.env', 'downloader-test-'));
  try {
    const data = Buffer.from('cmux artifact compatibility check');
    const checksum = crypto.createHash('sha256').update(data).digest('hex');
    let callbacks = 0;
    let downloads = 0;
    const file = await get.downloadArtifact({
      version: '99.0.0', artifactName: 'compat.bin', isGeneric: true,
      tempDirectory: directory, cacheRoot: path.join(directory, 'cache'),
      cacheMode: get.ElectronDownloadCacheMode.Bypass,
      mirrorOptions: { resolveAssetURL: async () => 'https://example.invalid/compat.bin' },
      checksums: { 'compat.bin': checksum },
      downloadOptions: { getProgressCallback: async () => { callbacks += 1; } },
      downloader: {
        download: async (url, target, options) => {
          assert.equal(url, 'https://example.invalid/compat.bin');
          downloads += 1;
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, data);
          await options.getProgressCallback({ transferred: data.length, total: data.length, percent: 1 });
        }
      }
    });
    assert(fs.readFileSync(file).equals(data));
    assert.equal(downloads, 1);
    assert.equal(callbacks, 1);
    console.log('Builder loads the patched downloader; artifact, callback and SHA256 APIs passed without network access.');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
