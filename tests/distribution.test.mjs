import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { configureCanvas, releaseCanvas } from '../src/render/page.js';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
async function walk(dir) {
  return (await Promise.all((await readdir(new URL(`${dir}/`, root), { withFileTypes: true })).map(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`./${dir}/${e.name}`]))).flat().sort();
}
test('プリキャッシュ一覧が全アプリ本体・vendor・アイコンと完全一致する', async () => {
  const context = { self: {} }; vm.runInNewContext(await read('precache.js'), context);
  const expected = ['./', './index.html', './manifest.webmanifest', './sw.js', './precache.js', ...await walk('src'), ...await walk('icons'), ...await walk('vendor')].sort();
  assert.deepEqual(Array.from(context.self.PRECACHE).sort(), expected); assert.equal(new Set(expected).size, expected.length);
  for (const asset of expected) if (asset !== './') assert.ok((await stat(new URL(asset, root))).isFile(), asset);
});
test('manifest と HTML はサブパス用の相対参照、iOS設定を持つ', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest')), html = await read('index.html');
  assert.equal(manifest.start_url, './'); assert.equal(manifest.scope, './'); assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.every(i => i.src.startsWith('./')));
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(match[1].startsWith('./'), match[1]);
  assert.match(html, /width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no/); assert.match(html, /apple-mobile-web-app-capable/);
});
test('承認依存だけを固定し、配布ファイルとLICENSEを同梱する', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.deepEqual(pkg.dependencies, { 'pdf-lib': '1.17.1', 'pdfjs-dist': '4.10.38', 'perfect-freehand': '1.2.2' });
  for (const [source, target] of [['pdfjs-dist/legacy/build/pdf.min.mjs', 'pdfjs/pdf.mjs'], ['pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.mjs'], ['pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib/pdf-lib.esm.min.js'], ['perfect-freehand/dist/esm/index.mjs', 'perfect-freehand/index.mjs']]) assert.deepEqual(await readFile(new URL(`node_modules/${source}`, root)), await readFile(new URL(`vendor/${target}`, root)));
  for (const file of ['vendor/pdfjs/LICENSE', 'vendor/pdf-lib/LICENSE.md', 'vendor/perfect-freehand/LICENSE']) assert.ok((await read(file)).length > 100);
});
test('PNGアイコンの寸法が180/192/512pxである', async () => { for (const size of [180, 192, 512]) { const data = await readFile(new URL(`icons/${size === 180 ? 'apple-touch-icon' : `icon-${size}`}.png`, root)); assert.equal(data.subarray(1, 4).toString(), 'PNG'); assert.equal(data.readUInt32BE(16), size); assert.equal(data.readUInt32BE(20), size); } });
test('高倍率でもcanvasメモリーを制限し解放する', () => {
  const canvas = { style: {}, getContext: () => ({ setTransform() {} }), remove() { this.removed = true; } };
  configureCanvas(canvas, { width: 595.28, height: 841.89 }, 4, 3); assert.ok(canvas.width * canvas.height < 1804000); assert.equal(canvas.style.width, `${595.28 * 4}px`);
  releaseCanvas(canvas); assert.equal(canvas.width, 0); assert.equal(canvas.height, 0); assert.equal(canvas.removed, true);
});
test('静的サーバーの実プロセスで index・sw・vendor がHTTP 200、終了を確認', { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: fileURLToPath(root), env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
  const exit = once(child, 'exit');
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`起動待ちがタイムアウトしました ${errors}`)), 8000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`起動失敗 ${code}: ${errors}`)); });
      child.stdout.on('data', bytes => { const match = bytes.toString().match(/http:\/\/127\.0\.0\.1:\d+\//); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    for (const file of ['index.html', 'sw.js','precache.js','src/app.js','src/ui/editor.js','src/ui/pages.js','src/ui/export.js','src/import/pdf.js','src/import/notebooks.js','src/export/pdf.js','src/export/raster.js','src/storage/backup.js', 'vendor/perfect-freehand/index.mjs', 'vendor/pdfjs/pdf.mjs', 'vendor/pdfjs/pdf.worker.mjs', 'vendor/pdf-lib/pdf-lib.esm.min.js']) { const response = await fetch(new URL(file, url)); assert.equal(response.status, 200, file); assert.match(response.headers.get('content-type'), /(?:text\/html|javascript)/); await response.arrayBuffer(); }
    assert.equal((await fetch(new URL('.npm-cache/_logs/', url))).status, 404);
    assert.equal((await fetch(new URL('node_modules/pdf-lib/package.json', url))).status, 404);
  } finally { child.kill(); await exit; assert.notEqual(child.signalCode ?? child.exitCode, null); }
});
