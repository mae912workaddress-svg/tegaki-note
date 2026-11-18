import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
function worker() {
  const listeners = {}, responses = new Map(), deleted = [], additions = [];
  let online = true, body = 'new network', status = 200;
  const scope = 'https://example.test/repo/';
  const key = req => new URL(typeof req === 'string' ? req : req.url || req.href, scope).href.split('?')[0];
  const cache = { async addAll(paths) { additions.push(...paths); }, async put(req, response) { responses.set(key(req), response); }, async match(req) { return responses.get(key(req))?.clone(); } };
  const context = {
    self: { location: { origin: 'https://example.test' }, registration: { scope }, clients: { claim: async () => {} }, addEventListener: (name, fn) => { listeners[name] = fn; } },
    caches: { open: async () => cache, keys: async () => ['tegaki-note-v0', 'tegaki-note-v1.1.1', 'tegaki-note-v1.2.0', 'tegaki-note-v1.3.0', 'tegaki-note-v1.3.1', 'tegaki-note-v1.3.2', 'unrelated-app'], delete: async name => { deleted.push(name); } },
    fetch: async () => { if (!online) throw new Error('offline'); return new Response(body, { status }); }, URL, Response,
    importScripts: () => { context.self.PRECACHE = ['./', './index.html']; }
  };
  vm.runInNewContext(source, context);
  return { cache, additions, deleted, network(nextOnline, nextBody = body, nextStatus = 200) { online = nextOnline; body = nextBody; status = nextStatus; }, async fire(name, request) {
    const waits = []; let response;
    listeners[name]({ request, waitUntil: promise => waits.push(promise), respondWith: promise => { response = promise; } });
    const value = await response; await Promise.all(waits); return value;
  } };
}
test('Service Worker install は全資産をプリキャッシュする', async () => { const w = worker(); await w.fire('install'); assert.deepEqual(w.additions, ['./', './index.html']); });
test('network-first はオンラインの新しい内容でキャッシュを更新する', async () => {
  const w = worker(), req = new Request('https://example.test/repo/src/ui/styles.css'); await w.cache.put(req, new Response('old cached'));
  assert.equal(await (await w.fire('fetch', req)).text(), 'new network'); w.network(false); assert.equal(await (await w.fire('fetch', req)).text(), 'new network');
});
test('HTTPエラーではキャッシュへ、未保存資産では503へフォールバックする', async () => {
  const w = worker(), req = new Request('https://example.test/repo/src/app.js'); await w.cache.put(req, new Response('valid cached')); w.network(true, 'error', 500);
  assert.equal(await (await w.fire('fetch', req)).text(), 'valid cached'); w.network(false); assert.equal((await w.fire('fetch', new Request('https://example.test/repo/missing'))).status, 503);
});
test('オフラインのナビゲーションはサブパスのindexを返す', async () => {
  const w = worker(); await w.cache.put('https://example.test/repo/index.html', new Response('app shell')); w.network(false);
  const response = await w.fire('fetch', { url: 'https://example.test/repo/?from=home', method: 'GET', mode: 'navigate' }); assert.equal(await response.text(), 'app shell');
});
test('activate は旧版だけを削除し、外部オリジンとPOSTを扱わない', async () => {
  const w = worker(); await w.fire('activate'); assert.deepEqual(w.deleted, ['tegaki-note-v0', 'tegaki-note-v1.1.1', 'tegaki-note-v1.2.0', 'tegaki-note-v1.3.0', 'tegaki-note-v1.3.1']);
  assert.equal(await w.fire('fetch', new Request('https://other.test/')), undefined); assert.equal(await w.fire('fetch', new Request('https://example.test/repo/', { method: 'POST' })), undefined);
});
