import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository } from '../src/storage/db.js';
import { Autosave } from '../src/storage/autosave.js';
import { createNotebook } from '../src/model/notebooks.js';
import { createBackup,validateBackup } from '../src/storage/backup.js';

// A transactional test double verifies request order and failure propagation.
// Real WebKit IndexedDB/lifecycle behavior remains an iPad acceptance check.
function transactionalDB(initial, failStore) {
  const state = structuredClone(initial), observed = [];
  return { state, observed, transaction(stores, mode) {
    observed.push({ stores, mode }); const draft = structuredClone(state); let aborted = false;
    const tx = { error: null, abort() { if (aborted) return; aborted = true; queueMicrotask(() => tx.onabort?.()); }, objectStore(store) {
      assert.ok(stores.includes(store));
      return {
        get(id) { const req = {}; queueMicrotask(() => { if (aborted) return; req.result = structuredClone(draft[store][id]); try { req.onsuccess?.(); } catch (e) { tx.error = e; tx.abort(); } }); return req; },
        put(value) { if (store === failStore) throw new Error('QuotaExceededError'); draft[store][value.id] = structuredClone(value); },
        add(value) { if (store === failStore) throw new Error('QuotaExceededError'); if(draft[store][value.id])throw new Error('ConstraintError');draft[store][value.id]=structuredClone(value); },
        clear() { draft[store]={}; },
        delete(id) { delete draft[store][id]; }
      };
    } };
    setImmediate(() => { if (aborted) return; for (const store of stores) state[store] = draft[store]; tx.oncomplete?.(); }); return tx;
  } };
}
const recordState=raw=>Object.fromEntries(['folders','notebooks','pages','files'].map(s=>[s,Object.fromEntries(raw[s].map(v=>[v.id,v]))]));
function allRecords(){const n=createNotebook();return {folders:[],notebooks:[n.notebook],pages:n.pages,files:[{id:'image',name:'x.jpg',mime:'image/jpeg',blob:new Blob(['image'],{type:'image/jpeg'})}]};}
test('バックアップ→全ストア空→復元は単一トランザクションで元に戻る',async()=>{
  const raw=allRecords();raw.pages[0].background={type:'image',fileId:'image'};
  const backup=await createBackup(raw),db=transactionalDB(recordState(raw)),repo=new Repository(db);
  await repo.replaceAll({folders:[],notebooks:[],pages:[],files:[]});assert.deepEqual(db.state,{folders:{},notebooks:{},pages:{},files:{}});
  await repo.replaceAll(validateBackup(backup));assert.deepEqual(db.state,recordState(raw));
  assert.deepEqual(db.observed.map(v=>v.stores),[['folders','notebooks','pages','files'],['folders','notebooks','pages','files']]);
});
test('復元中の容量不足はclear済みを含む全ストアの既存データを保持する',async()=>{
  const raw=allRecords(),db=transactionalDB(recordState(raw),'files'),before=structuredClone(db.state),repo=new Repository(db);
  const next=allRecords();await assert.rejects(repo.replaceAll(next),/QuotaExceeded/);assert.deepEqual(db.state,before);assert.equal(db.observed.length,1);
});
test('不正な復元データはトランザクション開始前に拒否される',()=>{
  const db=transactionalDB(recordState(allRecords())),repo=new Repository(db),raw=allRecords();delete raw.files;
  assert.throws(()=>repo.replaceAll(raw));assert.equal(db.observed.length,0);
});
test('読み込み中のファイル保存失敗は追加したノート・ページを確定しない',async()=>{
  const raw=allRecords(),db=transactionalDB(recordState(raw),'files'),before=structuredClone(db.state),repo=new Repository(db);
  await assert.rejects(repo.importRecords(allRecords()),/QuotaExceeded/);assert.deepEqual(db.state,before);
});
test('画像追加の保存失敗は画像とページと更新日時のすべてを保持する',async()=>{
  const raw=allRecords(),db=transactionalDB(recordState(raw),'pages'),before=structuredClone(db.state),repo=new Repository(db);
  const page={...raw.pages[0],items:[{id:'i',type:'image',fileId:'new',x:0,y:0,w:100,h:100}]};
  await assert.rejects(repo.savePageWithFile(page,{...raw.files[0],id:'new'}));assert.deepEqual(db.state,before);
});
function setup(failStore) {
  const data = createNotebook(); const db = transactionalDB({ notebooks: { [data.notebook.id]: { ...data.notebook, updatedAt: 0 } }, pages: { [data.pages[0].id]: data.pages[0] } }, failStore);
  return { data, db, repository: new Repository(db) };
}
test('ページ保存と更新日時が単一readwriteトランザクションで完了する', async () => {
  const { data, db, repository } = setup(); const page = structuredClone(data.pages[0]); page.text = 'changed';
  await repository.savePage(page); assert.deepEqual(db.observed, [{ stores: ['pages', 'notebooks'], mode: 'readwrite' }]); assert.equal(db.state.pages[page.id].text, 'changed'); assert.ok(db.state.notebooks[data.notebook.id].updatedAt > 0);
});
test('ノート更新で失敗すると、先に要求したページ変更も確定しない', async () => {
  const { data, db, repository } = setup('notebooks'), before = structuredClone(db.state); const page = structuredClone(data.pages[0]); page.text = 'changed';
  await assert.rejects(repository.savePage(page), /QuotaExceeded/); assert.deepEqual(db.state, before);
});
test('削除済みノートへの遅延保存が孤立ページを作らない', async () => {
  const { data, db, repository } = setup(); delete db.state.notebooks[data.notebook.id]; const before = structuredClone(db.state);
  await assert.rejects(repository.savePage(data.pages[0])); assert.deepEqual(db.state, before);
});
test('構造変更の保存失敗はノートとページ両方を保持する', async () => {
  const { data, db, repository } = setup('pages'), before = structuredClone(db.state);
  await assert.rejects(repository.saveNotebook({ ...data.notebook, name: 'changed' }, [{ ...data.pages[0], text: 'changed' }])); assert.deepEqual(db.state, before);
});
test('自動保存の既定は500msで、デバウンス後にスナップショットを保存する', async () => {
  assert.equal(new Autosave({}, () => {}).delay, 500);
  const writes = [], messages = [], saver = new Autosave({ savePage: async p => { writes.push(p); } }, m => messages.push(m), 10);
  const page = createNotebook().pages[0]; saver.mark(page); page.text = 'later'; saver.mark(page); page.text = 'unsaved mutation';
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(writes.length, 1); assert.equal(writes[0].text, 'later'); assert.equal(saver.dirty.size, 0); assert.equal(messages.at(-1), '保存済み');
});
test('保存失敗ではdirtyを保持し、再保存で回復する', async () => {
  let fail = true; const messages = [], saver = new Autosave({ savePage: async () => { if (fail) throw new Error('容量不足'); } }, (m, e) => messages.push({ m, e }), 60000);
  saver.mark(createNotebook().pages[0]); await assert.rejects(saver.flush(), /容量不足/); assert.equal(saver.dirty.size, 1); assert.ok(messages.at(-1).e);
  fail = false; await saver.flush(); assert.equal(saver.dirty.size, 0); assert.equal(messages.at(-1).m, '保存済み');
});
test('保存中の追記を旧保存の完了で消さず、flushは最新保存まで待つ', async () => {
  const requests = [], saver = new Autosave({ savePage: p => new Promise(resolve => requests.push({ page: p, resolve })) }, () => {}, 60000);
  const page = createNotebook().pages[0]; saver.mark(page); const pending = saver.flush(); assert.equal(requests.length, 1);
  page.text = 'newer'; saver.mark(page); requests[0].resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(requests.length, 2); assert.equal(requests[1].page.text, 'newer');
  requests[1].resolve(); await pending; assert.equal(saver.dirty.size, 0); clearTimeout(saver.timer);
});
