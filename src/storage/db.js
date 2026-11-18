import { validateRecords } from '../model/validation.js';
import { assertRecords, prepareBackupRestore } from './backup.js';
export const DB_NAME = 'tegaki-note';
export const SCHEMA_VERSION = 1;
const STORES = ['folders', 'notebooks', 'pages', 'files'];
export const EDITING_LOCK = 'tegaki-editing';
const publicFile = ({ editingLeases, ...file }) => file;
function pageFileIds(page) {
  return [...(page.background ? [page.background.fileId] : []), ...page.items.filter(i => i.type === 'image').map(i => i.fileId)];
}
export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, SCHEMA_VERSION);
    request.onupgradeneeded = () => { for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'id' }); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('別のタブを閉じてから再読み込みしてください'));
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(new Repository(db)); };
  });
}
export class Repository {
  constructor(db, { requestLock = globalThis.navigator?.locks?.request.bind(globalThis.navigator.locks) } = {}) {
    this.db = db; this.requestLock = requestLock; this.editingFiles = new Set();
  }
  retainEditingFiles() {
    const session = {};
    let unlock, held, closing, recovery, repairing, released = false, lost = false, protectedNow = false, generation = 0;
    const acquire = () => {
      lost = false;
      const attempt = ++generation;
      session.pending = new Promise((resolve, reject) => {
        if (!this.requestLock) { protectedNow = true; resolve(); return; }
        try {
          held = this.requestLock(EDITING_LOCK, { mode:'shared' }, lock => {
            if (!lock) throw new Error('編集用ロックを取得できません');
            protectedNow = true;
            const lifetime = new Promise(done => { unlock = done; });
            resolve(); return lifetime;
          });
          const ended = error => {
            if (attempt === generation) { protectedNow = false; lost = true; }
            reject(error || new Error('編集用ロックが終了しました'));
          };
          // WebKit can reject the request after the acquisition promise resolved.
          Promise.resolve(held).then(() => ended(), ended);
        } catch (error) { lost = true; reject(error); }
      });
      void session.pending.catch(() => {});
    };
    acquire(); this.editingFiles.add(session);
    session.ensure = () => {
      if (released || closing) return Promise.resolve();
      if (repairing) return repairing;
      repairing = (async () => {
        // Allow an already-settled request's loss notification to run first.
        await Promise.resolve();
        if (lost) {
          await recovery?.();
          lost = false; acquire();
          await session.pending;
          await recovery?.();
        } else await session.pending;
        if (lost || !protectedNow) throw new Error('編集用ロックを再取得できません。もう一度お試しください。');
      })().finally(() => { repairing = null; });
      return repairing;
    };
    const release = async collect => {
      await repairing?.catch(() => {});
      try { await session.pending; } catch { /* Acquisition or ownership was lost. */ }
      ++generation; protectedNow = false;
      unlock?.();
      try { await held; } catch { /* AbortError must not strand an editing session. */ }
      // An unmounted editor has no Undo history to preserve on collection error.
      if (!collect) { released = true; this.editingFiles.delete(session); return; }
      try {
        await this.withCollection(enabled => enabled
          ? this.transaction(['notebooks','pages','files'], tx => this.collectUnreferenced(tx))
          : Promise.resolve(), error => { if (error.name !== 'AbortError') acquire(); });
        released = true; this.editingFiles.delete(session);
      } catch (error) {
        if (error.name === 'AbortError') { released = true; this.editingFiles.delete(session); return; }
        // Protection is queued again while the failed collector still holds its lock.
        await session.pending;
        throw error;
      }
    };
    return {
      get ready() { return session.ensure(); },
      get lost() { return lost; },
      ensure: session.ensure,
      setRecoveryHandler: handler => { recovery = handler; },
      release: ({ collect = true } = {}) => {
        if (released) return Promise.resolve();
        if (!closing) closing = release(collect).finally(() => { closing = null; });
        return closing;
      }
    };
  }
  async editingReady() {
    for (const session of this.editingFiles) await session.ensure();
  }
  existingFileIds() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['files'], 'readonly'), request = tx.objectStore('files').getAllKeys
        ? tx.objectStore('files').getAllKeys() : tx.objectStore('files').getAll();
      tx.oncomplete = () => resolve(new Set(request.result.map(value => typeof value === 'string' ? value : value.id)));
      tx.onabort = () => reject(tx.error || new Error('履歴の画像を確認できません'));
    });
  }
  async withCollection(action, onFailure) {
    if (!this.requestLock) return action(false);
    return this.requestLock(EDITING_LOCK, { mode:'exclusive', ifAvailable:true }, async lock => {
      try { return await action(Boolean(lock)); }
      catch (error) { onFailure?.(error); throw error; }
    });
  }
  collectFiles() {
    return this.withCollection(enabled => enabled
      ? this.transaction(['notebooks','pages','files'], tx => this.collectUnreferenced(tx))
      : Promise.resolve());
  }
  collectUnreferenced(tx) {
    // Mutations and the complete reference scan share a single write transaction.
    const request = tx.objectStore('pages').getAll();
    request.onsuccess = () => {
      const used = new Set(request.result.flatMap(pageFileIds));
      const files = tx.objectStore('files'), all = files.getAll();
      all.onsuccess = () => {
        for (const file of all.result) {
          if (!used.has(file.id)) files.delete(file.id);
          else if (file.editingLeases) files.put(publicFile(file));
        }
      };
    };
  }
  importRecords(records) {
    return this.transaction(STORES, tx => {
      for (const store of STORES) for (const record of records[store]) tx.objectStore(store).add(store === 'files' ? publicFile(record) : record);
    });
  }
  async restoreBackup(input, options) {
    const records = await prepareBackupRestore(input, options);
    return this.replaceAll(records);
  }
  replaceAll(records) {
    const checked = assertRecords(records);
    return this.transaction(STORES, tx => {
      for (const store of STORES) { const target = tx.objectStore(store); target.clear(); for (const record of checked[store]) target.put(store === 'files' ? publicFile(record) : record); }
    });
  }
  getFile(id) {
    return new Promise((resolve,reject) => {
      const tx=this.db.transaction(['files'],'readonly'), req=tx.objectStore('files').get(id);
      tx.oncomplete=() => req.result ? resolve(publicFile(req.result)) : reject(new Error('画像・PDFが見つかりません'));
      tx.onabort=() => reject(tx.error || new Error('ファイルを取得できません'));
    });
  }
  async savePageWithFile(page,file) {
    page = structuredClone(page); file = structuredClone(file);
    await this.editingReady();
    return this.transaction(['pages','files','notebooks'],tx => {
      const notebooks=tx.objectStore('notebooks'), req=notebooks.get(page.notebookId);
      req.onsuccess=() => {
        if (!req.result?.pageIds.includes(page.id)) { tx.abort(); return; }
        tx.objectStore('files').put(publicFile(file));
        this.checkPageFiles(tx, [page], () => {
          tx.objectStore('pages').put(page);
          notebooks.put({...req.result,updatedAt:Date.now()});
        });
      };
    });
  }
  transaction(stores, action) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(stores, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.saveError || tx.error || new Error('保存が中断されました'));
      tx.onerror = () => {}; // onabort reports the final outcome, never request success.
      try { action(tx); } catch (error) { tx.abort(); reject(error); }
    });
  }
  load() {
    return new Promise((resolve, reject) => {
      const raw = {}, tx = this.db.transaction(STORES, 'readonly');
      for (const store of STORES) { const req = tx.objectStore(store).getAll(); req.onsuccess = () => { raw[store] = req.result; }; }
      tx.oncomplete = () => { raw.files = raw.files.map(publicFile); resolve(validateRecords(raw)); };
      tx.onabort = () => reject(tx.error || new Error('読み込みが中断されました'));
      tx.onerror = () => {};
    });
  }
  checkPageFiles(tx, pages, done) {
    const ids = [...new Set(pages.flatMap(pageFileIds))];
    if (!ids.length) { done(); return; }
    let remaining = ids.length;
    for (const id of ids) {
      const req = tx.objectStore('files').get(id);
      req.onsuccess = () => {
        if (!req.result) { tx.saveError = new Error('画像・PDFが見つからないため保存できません。バックアップから復元してください。'); tx.abort(); return; }
        if (--remaining === 0) done();
      };
    }
  }
  async savePage(page) {
    const snapshot = structuredClone(page);
    await this.editingReady();
    return this.transaction(['pages', 'notebooks', ...(pageFileIds(snapshot).length ? ['files'] : [])], tx => {
      const notebooks = tx.objectStore('notebooks'), req = notebooks.get(snapshot.notebookId);
      req.onsuccess = () => {
        if (!req.result?.pageIds.includes(snapshot.id)) { tx.abort(); return; }
        this.checkPageFiles(tx, [snapshot], () => {
          tx.objectStore('pages').put(snapshot);
          notebooks.put({ ...req.result, updatedAt: Date.now() });
        });
      };
    });
  }
  async saveNotebook(notebook, pages, removedIds = []) {
    notebook = structuredClone(notebook); pages = structuredClone(pages); removedIds = [...removedIds];
    await this.editingReady();
    const save = collect => this.transaction(['notebooks', 'pages', ...(removedIds.length || pages.some(p => pageFileIds(p).length) ? ['files'] : [])], tx => {
      this.checkPageFiles(tx, pages, () => {
        tx.objectStore('notebooks').put(structuredClone(notebook));
        for (const page of pages) tx.objectStore('pages').put(structuredClone(page));
        for (const id of removedIds) tx.objectStore('pages').delete(id);
        if (removedIds.length && collect) this.collectUnreferenced(tx);
      });
    });
    return removedIds.length ? this.withCollection(save) : save(false);
  }
  async deleteNotebook(notebook) {
    await this.editingReady();
    return this.withCollection(collect => this.transaction(['notebooks', 'pages', 'files'], tx => {
      tx.objectStore('notebooks').delete(notebook.id);
      notebook.pageIds.forEach(id => tx.objectStore('pages').delete(id));
      if (collect) this.collectUnreferenced(tx);
    }));
  }
  saveFolder(folder) { return this.transaction(['folders'], tx => tx.objectStore('folders').put(folder)); }
  deleteFolder(folderId) {
    return this.transaction(['folders', 'notebooks'], tx => {
      tx.objectStore('folders').delete(folderId);
      const req = tx.objectStore('notebooks').openCursor();
      req.onsuccess = () => { const cursor = req.result; if (!cursor) return; if (cursor.value.folderId === folderId) cursor.update({ ...cursor.value, folderId: null, updatedAt: Date.now() }); cursor.continue(); };
    });
  }
}
