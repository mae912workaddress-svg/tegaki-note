import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, constants as zlibConstants } from 'node:zlib';
import { Repository } from '../src/storage/db.js';
import { createLocks } from './helpers/20261118-locks.mjs';
import { createBackup, decodeBase64 } from '../src/storage/backup.js';
import { createNotebook, addPage, removePage, duplicateNotebook } from '../src/model/notebooks.js';
import { History } from '../src/model/history.js';
import { Autosave } from '../src/storage/autosave.js';
import { validateImageContents } from '../src/model/images.js';
import { prepareImage } from '../src/import/images.js';
import { importFiles } from '../src/import/notebooks.js';
import { openPdf, PDF_ANNOTATION_MODE } from '../src/import/pdf.js';
import { exportPdf } from '../src/export/pdf.js';
import { PDFDocument, PDFName, PDFString, PDFBool, degrees } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import { OPS } from '../vendor/pdfjs/pdf.mjs';
import { validatePdfContents } from '../src/model/validation.js';

function ascii85(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const count = Math.min(4, bytes.length - i); let value = 0, group = '';
    for (let j = 0; j < 4; j++) value = value * 256 + (bytes[i+j] ?? 0);
    for (let j = 0; j < 5; j++) { group = String.fromCharCode(value % 85 + 33) + group; value = Math.floor(value / 85); }
    text += group.slice(0, count + 1);
  }
  return Buffer.from(text + '~>');
}
async function flatePdf(bytes, chain = false) {
  const pdf = await PDFDocument.create(), page = pdf.addPage();
  page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream(chain ? ascii85(bytes) : bytes, {
    Filter:chain ? ['ASCII85Decode','FlateDecode'].map(PDFName.of) : 'FlateDecode'
  })));
  return await pdf.save();
}
for (const mode of ['先頭9バイト','チェックサム欠落','チェックサム不一致','ASCII85連結の先頭9バイト']) {
  test(`USR-001/REV-011: ${mode}のバックアップ後破損をSHA-256で拒否し既存全ストアを保持する`, async () => {
    const compressed = deflateSync(Buffer.from('q 1 0 0 rg 20 20 40 40 re f Q'), {level:0});
    const chain = mode.startsWith('ASCII85');
    let broken;
    if (mode.includes('9バイト')) broken = compressed.subarray(0,9);
    else if (mode === 'チェックサム欠落') broken = compressed.subarray(0,-1);
    else { broken = Buffer.from(compressed); broken[broken.length-1] ^= 1; }
    const backup = await createBackup(records(await flatePdf(compressed,chain),'application/pdf'));
    backup.files[0].base64 = Buffer.from(await flatePdf(broken,chain)).toString('base64');
    const raw = records(); raw.folders.push({id:'folder',name:'既存フォルダ',order:0,createdAt:1,updatedAt:1}); raw.notebooks[0].folderId='folder';
    const db=database(raw),repo=new Repository(db),before=structuredClone(db.state);
    await assert.rejects(repo.restoreBackup(backup), /SHA-256またはバイト長/);
    assert.deepEqual(db.state,before); assert.equal(db.observed.length,0);
  });
}

for (const [mode, compression] of [['stored',{level:0}], ['fixed',{strategy:zlibConstants.Z_FIXED}], ['dynamic',{level:9}]]) {
  test(`REV-011: ${mode}の正常Flate末尾の改行・ゴミを復元・取込み・連結フィルターで許容する`, async () => {
    const compressed = deflateSync(Buffer.from('q Q\n'.repeat(1000)),compression);
    for (const tail of [Buffer.from('\r\n'),Buffer.from([0,255,1,2,3,10])]) {
      const bytes = Buffer.concat([compressed,tail]);
      for (const chain of [false,true]) {
        const pdf = await flatePdf(bytes,chain);
        const db = database(records()), repo = new Repository(db);
        await repo.restoreBackup(await createBackup(records(pdf,'application/pdf')));
        assert.deepEqual((await repo.load()).warnings,[]);
        const imported = await importFiles([new File([pdf],'trailing.pdf',{type:'application/pdf'})],null);
        assert.equal(imported.pages.length,1);
      }
    }

  });
}

test('USR-001/REV-011: 末尾ゴミ付きの途中終了・チェックサム破損を復元ハッシュで拒否する', async () => {
  const compressed = deflateSync(Buffer.from('q Q'),{level:0});
  for (const damaged of [compressed.subarray(0,9),compressed.subarray(0,-1),Buffer.from(compressed)]) {
    if (damaged.length === compressed.length) damaged[damaged.length-1] ^= 1;
    const backup=await createBackup(records(await flatePdf(compressed),'application/pdf'));
    backup.files[0].base64=Buffer.from(await flatePdf(Buffer.concat([damaged,Buffer.from('\nextra garbage')]))).toString('base64');
    const db=database(records()),before=structuredClone(db.state);
    await assert.rejects(new Repository(db).restoreBackup(backup),/SHA-256またはバイト長/);
    assert.deepEqual(db.state,before);assert.equal(db.observed.length,0);
  }
});

test('USR-001/REV-009: embedPdfのForm破損を復元ハッシュで拒否し全ストアを保持する', async () => {
  const original = await PDFDocument.create(); original.addPage().drawText('Embedded text');
  const outer = await PDFDocument.create(), [embedded] = await outer.embedPdf(await original.save());
  outer.addPage().drawPage(embedded);
  const parsed = await PDFDocument.load(await outer.save());
  const xobjects = parsed.getPage(0).node.Resources().lookup(PDFName.of('XObject'));
  const form = xobjects.lookup(xobjects.keys()[0]);
  const backup = await createBackup(records(await parsed.save(),'application/pdf'));
  const bytes = form.getContents(); bytes[0] = 1; bytes[1] = 2;
  const corrupted = await parsed.save(), db = database(records()), repo = new Repository(db), before = structuredClone(db.state);
  backup.files[0].base64=Buffer.from(corrupted).toString('base64');
  await assert.rejects(repo.restoreBackup(backup), /SHA-256またはバイト長/);
  assert.deepEqual(db.state, before); assert.equal(db.observed.length, 0);
  // PDF.js warnings are accepted during import; restore checks byte identity.
  assert.equal((await importFiles([new File([corrupted],'form.pdf',{type:'application/pdf'})])).pages.length,1);
});

for (const path of ['Form/Resources/XObject','Pattern','Shading/Function','Font/FontDescriptor/FontFile2','Annots/AP/N','Thumb','Metadata']) {
  test(`REV-009: ${path}の到達可能ストリーム破損を復元ハッシュで拒否する`, async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage(), context = pdf.context;
    const bad = context.flateStream('q Q'), ref = context.register(bad);
    const resources = page.node.Resources();
    if (path === 'Form/Resources/XObject') {
      const form = context.flateStream('q Q',{Type:'XObject',Subtype:'Form'}), formRef = context.register(form);
      form.dict.set(PDFName.of('Resources'),context.obj({XObject:{self:formRef,nested:ref}}));
      resources.set(PDFName.of('XObject'),context.obj({form:formRef}));
    } else if (path === 'Annots/AP/N') page.node.set(PDFName.of('Annots'),context.obj([{AP:{N:ref}}]));
    else if (path === 'Font/FontDescriptor/FontFile2') resources.set(PDFName.of('Font'),context.obj({F:{FontDescriptor:{FontFile2:ref}}}));
    else if (path === 'Shading/Function') resources.set(PDFName.of('Shading'),context.obj({S:{Function:ref}}));
    else if (path === 'Pattern') resources.set(PDFName.of('Pattern'),context.obj({P:ref}));
    else page.node.set(PDFName.of(path),ref);
    const backup=await createBackup(records(await pdf.save(),'application/pdf'));
    bad.getContents().set([1,2]); backup.files[0].base64=Buffer.from(await pdf.save()).toString('base64');
    const db=database(records()),before=structuredClone(db.state);
    await assert.rejects(new Repository(db).restoreBackup(backup),/SHA-256またはバイト長/);
    assert.deepEqual(db.state,before);assert.equal(db.observed.length,0);
  });
}

test('USR-001: 5フィルターと連結・共有Form循環を含むPDFを表示エンジンで検証する', async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage(), c = pdf.context;
  const plain = Buffer.from('q Q'), flate = deflateSync(plain);
  const bits = [256,113,32,81,257].map(n => n.toString(2).padStart(9,'0')).join('').padEnd(48,'0');
  const lzw = Buffer.from(bits.match(/.{8}/g).map(s => parseInt(s,2)));
  const cases = [
    ['FlateDecode',flate], ['LZWDecode',lzw], ['ASCIIHexDecode',Buffer.from('712051>')],
    ['ASCII85Decode',Buffer.from('z~>')], ['RunLengthDecode',Buffer.from([2,113,32,81,128])],
    [['ASCIIHexDecode','FlateDecode'],Buffer.from(flate.toString('hex')+'>')],
    ...['JPXDecode','JBIG2Decode','CCITTFaxDecode','FutureCodec'].map(name => [name,Buffer.from([1,2,3])])
  ];
  const objects = {};
  for (const [filter, bytes] of cases) {
    const stream = c.stream(bytes,{Filter:Array.isArray(filter) ? filter.map(PDFName.of) : PDFName.of(filter)});
    objects['S'+Object.keys(objects).length] = c.register(stream);
  }
  const form = c.flateStream('q Q',{Type:'XObject',Subtype:'Form'}), ref = c.register(form);
  form.dict.set(PDFName.of('Resources'),c.obj({XObject:{self:ref,...objects}}));
  page.node.Resources().set(PDFName.of('XObject'),c.obj({F:ref,shared:ref}));
  await validatePdfContents(new Blob([await pdf.save()]));
});

test('USR-001: 100ページの取込み・復元はpdf-libや独自展開を呼ばずPDF.jsで検証する', async t => {
  const pdf=await PDFDocument.create();for(let i=0;i<100;i++)pdf.addPage();
  const file=new File([await pdf.save()],'100.pdf',{type:'application/pdf'});
  t.mock.method(PDFDocument,'load',()=>{throw new Error('strict parser must not run');});
  const imported=await importFiles([file]);assert.equal(imported.pages.length,100);
  const repo=new Repository(database(records()));await repo.restoreBackup(await createBackup(imported));
  for(let i=0;i<3;i++){const shown=await openPdf(file);try{assert.equal(shown.numPages,100);}finally{await shown.destroy();}}
});

// Serializes transactions like IndexedDB (including different Repository instances).
// No browser, database dependency or localhost connection is needed.
function database(raw) {
  const state = Object.fromEntries(['folders','notebooks','pages','files'].map(s => [s,new Map(raw[s].map(v => [v.id,structuredClone(v)]))]));
  let tail = Promise.resolve();
  const observed = [];
  return { state, observed, transaction(stores, mode) {
    observed.push({ stores, mode });
    const jobs = []; let active = false, aborted = false, draft, finish, scheduled = false;
    const previous = tail; tail = new Promise(resolve => { finish = resolve; });
    const tx = { error:null, abort() { aborted = true; schedule(); }, objectStore(store) {
      assert.ok(stores.includes(store));
      const request = action => { const req = {}; jobs.push(() => { req.result = action(); req.onsuccess?.(); }); schedule(); return req; };
      return {
        get:id => request(() => structuredClone(draft[store].get(id))),
        getAll:() => request(() => structuredClone([...draft[store].values()])),
        put:v => { const copy = structuredClone(v); return request(() => draft[store].set(copy.id,copy)); },
        add:v => { const copy = structuredClone(v); return request(() => { if (draft[store].has(copy.id)) throw new Error('ConstraintError'); draft[store].set(copy.id,copy); }); },
        delete:id => request(() => draft[store].delete(id)),
        clear:() => request(() => draft[store].clear())
      };
    }};
    function schedule() {
      if (!active || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!aborted && jobs.length) { try { jobs.shift()(); } catch (e) { tx.error = e; aborted = true; } schedule(); return; }
        active = false;
        if (aborted) tx.onabort?.();
        else { if (mode === 'readwrite') for (const s of stores) state[s] = draft[s]; tx.oncomplete?.(); }
        finish();
      });
    }
    previous.then(() => { draft = structuredClone(state); active = true; schedule(); });
    return tx;
  }};
}
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(type,4); out.set(data,8);
  let crc = 0xffffffff;
  for (const n of out.subarray(4,-4)) { crc ^= n; for (let i=0;i<8;i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  out.writeUInt32BE(~crc >>> 0,out.length-4); return out;
}
function png(body = deflateSync(Buffer.from([0,255,0,0,255]))) {
  const header = Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',body),chunk('IEND',Buffer.alloc(0))]);
}
const file = (id,bytes,mime='image/png') => ({ id,name:id,mime,blob:new Blob([bytes],{type:mime}) });
function records(bytes=png(),mime='image/png') {
  const a = createNotebook({name:'existing'}), b = createNotebook({name:'other'});
  a.pages[0].background = { type:mime === 'application/pdf' ? 'pdf' : 'image',fileId:'asset',...(mime === 'application/pdf' ? {pageIndex:0} : {}) };
  return { folders:[],notebooks:[a.notebook,b.notebook],pages:[...a.pages,...b.pages],files:[file('asset',bytes,mime)] };
}
const collect = repo => repo.collectFiles();

test('REV-001: PNG先頭33バイトの背景をrestoreBackupで拒否し既存ノートを全件保持する',async () => {
  const raw = records(), db = database(raw), repo = new Repository(db), backup = await createBackup(records(png().subarray(0,33)));
  const before = structuredClone(db.state);
  await assert.rejects(repo.restoreBackup(backup),/PNG/);
  assert.deepEqual(db.state,before); assert.equal(db.observed.length,0);
  await repo.restoreBackup(await createBackup(raw)); assert.equal((await repo.load()).notebooks.length,2);
});
test('REV-001: PNGの全CRC・IDAT・IEND・zlib破損とJPEGのSOS・EOI欠落を置換前に拒否する',async () => {
  const badCRC = png(); badCRC[badCRC.length-17] ^= 1;
  const header = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0]);
  const scan = Buffer.from([255,218,0,8,1,1,0,0,63,0,42]);
  const jpeg = Buffer.concat([header,scan,Buffer.from([255,217])]);
  await validateImageContents(new Blob([jpeg],{type:'image/jpeg'}));
  const cases = [[badCRC,'image/png'],[png().subarray(0,-12),'image/png'],[Buffer.concat([png().subarray(0,33),chunk('IEND',Buffer.alloc(0))]),'image/png'],[png(Buffer.from([1,2,3])),'image/png'],[png(deflateSync(Buffer.from([0,255]))),'image/png'],[png(deflateSync(Buffer.from([5,255,0,0,255]))),'image/png'],[header,'image/jpeg'],[Buffer.concat([header,Buffer.from([255,217])]),'image/jpeg'],[jpeg.subarray(0,-2),'image/jpeg']];
  const db = database(records()), repo = new Repository(db), before = structuredClone(db.state);
  for (const [bytes,mime] of cases) await assert.rejects(repo.restoreBackup(await createBackup(records(bytes,mime))));
  assert.deepEqual(db.state,before); assert.equal(db.observed.length,0);
});
test('REV-001: ブラウザーデコーダーは順次実行して即解放しデコード失敗で既存データを保持する',async () => {
  const raw = records(); raw.files.push(file('second',png()));
  raw.pages[1].background = { type:'image',fileId:'second' };
  const db = database(records()), repo = new Repository(db), before = structuredClone(db.state), events = [];
  let active = 0;
  const decode = async () => { assert.equal(active++,0); events.push('decode'); await Promise.resolve(); return {width:1,height:1,close() {active--;events.push('close');}}; };
  await repo.restoreBackup(await createBackup(raw),{decode});
  assert.deepEqual(events,['decode','close','decode','close']);
  const restored = structuredClone(db.state);
  await assert.rejects(repo.restoreBackup(await createBackup(raw),{decode:async () => {throw new Error('pixel decode failed');}}),/pixel decode failed/);
  assert.deepEqual(db.state,restored); assert.equal(before.notebooks.size,restored.notebooks.size);
});
test('REV-001: F4の画像取込みも切断画像とデコーダー失敗を拒否する',async () => {
  await assert.rejects(prepareImage(new File([png().subarray(0,33)],'bad.png',{type:'image/png'}),true),/PNG/);
  await assert.rejects(prepareImage(new File([png()],'image.png',{type:'image/png'}),true,{decode:async () => {throw new Error('decode rejected');}}),/decode rejected/);
  const truncatedJpeg = new File([new Uint8Array([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0])],'bad.jpg',{type:'image/jpeg'});
  await assert.rejects(importFiles([truncatedJpeg]),/EOI/);
});
test('REV-001: createImageBitmap・HTMLImageElementの実デコード経路と解放を使用する',async () => {
  const originalBitmap = globalThis.createImageBitmap, originalImage = globalThis.Image;
  let closed = 0, decoded = 0, htmlImage;
  try {
    globalThis.createImageBitmap = async () => ({width:1,height:1,close(){closed++;}});
    await validateImageContents(new Blob([png()],{type:'image/png'})); assert.equal(closed,1);
    delete globalThis.createImageBitmap;
    globalThis.Image = class { naturalWidth=1; naturalHeight=1; constructor(){htmlImage=this;} async decode(){decoded++;} };
    await validateImageContents(new Blob([png()],{type:'image/png'})); assert.equal(decoded,1); assert.equal(htmlImage.src,'');
  } finally {
    if (originalBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = originalBitmap;
    if (originalImage === undefined) delete globalThis.Image; else globalThis.Image = originalImage;
  }
});

test('REV-007: Aが編集中のまま300001ms経過→Bで削除回収→AでUndo保存が成功し画像を保持する',async t => {
  t.mock.timers.enable({apis:['Date'],now:1000});
  const raw = records(), page = raw.pages[0], locks = createLocks();
  page.background = null; page.items = [{id:'image-item',type:'image',fileId:'asset',x:10,y:10,w:100,h:100}];
  const db = database(raw), a = new Repository(db,locks.client()), b = new Repository(db,locks.client());
  const editing = a.retainEditingFiles(), history = new History(), before = structuredClone(page);
  await editing.ready;
  page.items = []; history.commit(before,page); await a.savePage(page);
  t.mock.timers.tick(300001);
  await b.deleteNotebook(raw.notebooks[1]); await collect(b);
  assert.equal(db.state.files.size,1);
  const backup = await createBackup(await b.load());
  assert.equal(backup.files.length,0); assert.equal(backup.counts.files,0);
  Object.assign(page,history.undo(page)); await a.savePage(page);
  const loaded = await a.load(); assert.equal(loaded.notebooks.length,1); assert.deepEqual(loaded.warnings,[]);
  assert.equal(loaded.pages[0].items[0].fileId,'asset'); assert.equal(loaded.files[0].editingLeases,undefined);
  await editing.release(); assert.equal(db.state.files.size,1);
});
test('REV-007: 編集ロックの取得と別タブの回収が競合しても画像を保護する',async () => {
  const raw = records(), db = database(raw), locks = createLocks();
  const a = new Repository(db,locks.client()), b = new Repository(db,locks.client());
  const editing = a.retainEditingFiles();
  const save = a.savePage({...raw.pages[0],background:null});
  await Promise.all([save,b.deleteNotebook(raw.notebooks[1]),editing.ready]);
  await collect(b); assert.equal(db.state.files.size,1);
  await editing.release(); assert.equal(db.state.files.size,0);
});
test('REV-007: Aの編集終了後もBの共有ロックを維持しBのタブ終了後に回収する',async () => {
  const raw = records(), db = database(raw), locks = createLocks(), tabB = locks.client();
  const a = new Repository(db,locks.client()), b = new Repository(db,tabB), collector = new Repository(db,locks.client());
  const first = a.retainEditingFiles(), second = b.retainEditingFiles();
  await Promise.all([first.ready,second.ready]);
  await a.savePage({...raw.pages[0],background:null}); await first.release();
  await collect(collector); assert.equal(db.state.files.size,1);
  tabB.close(); // Browser releases the lock without calling editor cleanup.
  await collect(collector); assert.equal(db.state.files.size,0);
});
test('REV-007: ロック非対応なら編集終了・ノート削除・起動時回収でも削除しない',async () => {
  const raw = records(), db = database(raw), repo = new Repository(db,{requestLock:null});
  const editing = repo.retainEditingFiles(); await editing.ready;
  await repo.savePage({...raw.pages[0],background:null}); await editing.release();
  await repo.deleteNotebook(raw.notebooks[0]); await collect(repo);
  assert.equal(db.state.files.size,1);
  assert.equal((await createBackup(await repo.load())).files.length,0);
});
test('REV-007: 編集中のページ削除は回収を延期し編集終了後に未参照分だけ回収する',async () => {
  const raw = records(), added = addPage(raw.notebooks[0],[raw.pages[0]]);
  added.page.background = structuredClone(raw.pages[0].background);
  const third = addPage(added.notebook,added.pages);
  raw.notebooks[0] = third.notebook; raw.pages = [...third.pages,raw.pages[1]];
  const db = database(raw), repo = new Repository(db,createLocks().client()), editing = repo.retainEditingFiles();
  const first = removePage(third.notebook,third.pages,third.pages[0].id);
  await repo.saveNotebook(first.notebook,[],[third.pages[0].id]); assert.equal(db.state.files.size,1);
  const second = removePage(first.notebook,first.pages,added.page.id);
  await repo.saveNotebook(second.notebook,[],[added.page.id]); assert.equal(db.state.files.size,1);
  await editing.release(); assert.equal(db.state.files.size,0); assert.deepEqual((await repo.load()).warnings,[]);
});
test('REV-007: 複製ノートの共有画像と正常PNGバックアップを維持する',async () => {
  const raw = records(), db = database(raw), repo = new Repository(db,createLocks().client());
  const copy = duplicateNotebook(raw.notebooks[0],[raw.pages[0]]);
  await repo.saveNotebook(copy.notebook,copy.pages); await repo.deleteNotebook(raw.notebooks[0]);
  const backup = await createBackup(await repo.load()); assert.equal(backup.files.length,1);
  await repo.restoreBackup(backup); assert.deepEqual((await repo.load()).warnings,[]);
  await repo.deleteNotebook(copy.notebook); assert.equal(db.state.files.size,0);
});
test('REV-007: ファイル再保存でも編集中の保護を維持し欠損画像の保存は全体を戻す',async () => {
  const raw = records(), db = database(raw), locks = createLocks();
  const a = new Repository(db,locks.client()), b = new Repository(db,locks.client());
  const editing = a.retainEditingFiles(); await editing.ready;
  const empty = {...raw.pages[0],background:null}; await a.savePage(empty);
  await b.savePageWithFile(empty,raw.files[0]); await collect(b); assert.equal(db.state.files.size,1);
  const before = structuredClone(db.state);
  await assert.rejects(b.savePageWithFile({...empty,background:{type:'image',fileId:'missing'}},file('new',png())),/見つからない/);
  await assert.rejects(a.savePage({...empty,background:{type:'image',fileId:'missing'}}),/見つからない/);
  await assert.rejects(a.saveNotebook(raw.notebooks[0],[{...empty,background:{type:'image',fileId:'missing'}}]),/見つからない/);
  assert.deepEqual(db.state,before); await editing.release(); assert.equal(db.state.files.size,0);
});
test('REV-007: 旧保持情報は読み込み・バックアップ・再保存で除外し回収判断に使わない',async () => {
  const raw = records(); raw.files[0].editingLeases = {old:{updatedAt:Date.now()+999999,pages:[]}};
  raw.files.push({...file('orphan',png()),editingLeases:{old:{}}});
  const db = database(raw), repo = new Repository(db,createLocks().client());
  assert.equal((await repo.getFile('asset')).editingLeases,undefined);
  assert.equal((await repo.load()).files[0].editingLeases,undefined);
  const backup = await createBackup(raw); assert.equal(backup.files.length,1); assert.equal(backup.files[0].editingLeases,undefined);
  await repo.savePageWithFile(raw.pages[0],raw.files[0]);
  assert.equal(db.state.files.get('asset').editingLeases,undefined);
  await collect(repo); assert.equal(db.state.files.size,1);
  await repo.deleteNotebook(raw.notebooks[0]); assert.equal(db.state.files.size,0);
});

for (const mode of ['NeedAppearances','missing AP','uncertain AP']) {
  test(`REV-003: ${mode}フォームをPDF.jsで描画し有効領域・回転・画像配置を保持する`,async () => {
    const source = await PDFDocument.create(), p = source.addPage([300,500]);
    p.setCropBox(-100,-100,400,600); p.setRotation(degrees(90));
    const form = source.getForm(), field = form.createTextField('value');
    field.setText('OLD'); field.addToPage(p,{x:20,y:50,width:200,height:40}); form.updateFieldAppearances();
    field.acroField.dict.set(PDFName.of('V'),PDFString.of('NEW'));
    if (mode === 'NeedAppearances') form.acroForm.dict.set(PDFName.of('NeedAppearances'),PDFBool.True);
    if (mode === 'missing AP') p.node.Annots().lookup(0).delete(PDFName.of('AP'));
    const bytes = await source.save({updateFieldAppearances:false}), original = bytes.slice();
    const imported = await importFiles([new File([bytes],'form.pdf',{type:'application/pdf'})]);
    let calls = 0, released = 0, text;
    const output = await exportPdf(imported.pages,{getFile:async id => imported.files.find(f => f.id === id),backgroundAssets:async (page,getFile,ratio) => {
      calls++;
      const pdf = await openPdf((await getFile(page.background.fileId)).blob);
      try {
        const page1 = await pdf.getPage(1), viewport = page1.getViewport({scale:ratio});
        assert.deepEqual([page.width,page.height],[500,300]); assert.deepEqual([viewport.width,viewport.height],[1000,600]);
        const ops = await page1.getOperatorList({annotationMode:PDF_ANNOTATION_MODE});
        text = ops.fnArray.flatMap((op,i) => op === OPS.showText ? ops.argsArray[i][0].filter(g => typeof g === 'object').map(g => g.unicode) : []).join('');
      } finally { await pdf.destroy(); }
      // Only canvas transport is substituted; source parsing/display operators and export run for real.
      return {background:{toBlob(callback){callback(new Blob([png()],{type:'image/png'}));}},release(){released++;}};
    }});
    assert.equal(calls,1); assert.equal(released,1); assert.deepEqual(bytes,original);
    if (mode === 'NeedAppearances') assert.match(text,/NEW/);
    const pdf = await openPdf(new Blob([output]));
    try {
      const page = await pdf.getPage(1), ops = await page.getOperatorList();
      assert.deepEqual([page.getViewport({scale:1}).width,page.getViewport({scale:1}).height],[500,300]);
      assert.ok(ops.fnArray.includes(OPS.paintImageXObject));
      assert.ok(ops.fnArray.some((op,i) => op === OPS.transform && JSON.stringify(ops.argsArray[i]) === '[500,0,0,300,0,0]'));
      assert.equal((await page.getAnnotations()).length,0);
    } finally { await pdf.destroy(); }
  });
}
test('REV-003: フォールバック後の画像埋込み失敗でも描画資産を解放する',async () => {
  const source = await PDFDocument.create(), p = source.addPage(), field = source.getForm().createTextField('value'); field.addToPage(p);
  const imported = await importFiles([new File([await source.save()],'form.pdf',{type:'application/pdf'})]); let released=0;
  await assert.rejects(exportPdf(imported.pages,{getFile:async () => imported.files[0],backgroundAssets:async () => ({background:{toBlob(cb){cb(null);}},release(){released++;}})}),/画像化に失敗/);
  assert.equal(released,1);
});
test('REV-008: 4195140バイトと20MiBの正常PDFバックアップを検証・復号・復元できる',async () => {
  const source = await PDFDocument.create(); source.addPage().drawText('large valid PDF');
  const small = await source.save({useObjectStreams:false});
  for (const size of [4195140,20*1024*1024]) {
    // PDF permits whitespace before EOF; keep the final EOF marker at the end.
    const eof = Buffer.from(small).lastIndexOf('%%EOF'), bytes = Buffer.alloc(size,32);
    bytes.set(small.subarray(0,eof)); bytes.set(Buffer.from('%%EOF\n'),size-6);
    const backup = await createBackup(records(bytes,'application/pdf')), repo = new Repository(database(records()));
    assert.equal(decodeBase64(backup.files[0].base64).length,size);
    await repo.restoreBackup(backup); const restored = await repo.getFile('asset');
    assert.equal(restored.blob.size,size); assert.deepEqual(Buffer.from(await restored.blob.arrayBuffer()),bytes);
    assert.deepEqual((await repo.load()).warnings,[]);
  }
});
test('REV-008: 不正文字・途中padding・過剰padding・非正規末尾ビットを拒否する',() => {
  for (const value of ['', 'a', '====', 'A===','AA=A','AAAA=AAA','AA$A','AA\nA','AB==','AAB=','あAAA']) assert.throws(() => decodeBase64(value));
  for (const value of ['AA==','AAA=','AAAA','+/8=']) assert.deepEqual(decodeBase64(value),new Uint8Array(Buffer.from(value,'base64')));
});

for (const mode of ['単一ストリーム','配列の後続ストリーム','後続ページ']) {
  test('REV-009: '+mode+'のFlateDecode本文破損を復元前に拒否し全ストアを保持する',async () => {
    const source = await PDFDocument.create();
    source.addPage([300,500]).drawText('Valid first text');
    if (mode === '後続ページ') source.addPage([300,500]).drawText('Second page text');
    const parsed = await PDFDocument.load(await source.save());
    const backup = await createBackup(records(await parsed.save(),'application/pdf'));
    const page = parsed.getPage(mode === '後続ページ' ? 1 : 0);
    const contents = page.node.Contents(), stream = contents.lookup(0);
    if (mode === '単一ストリーム') page.node.set(PDFName.of('Contents'),contents.get(0));
    if (mode === '配列の後続ストリーム') {
      const extra = parsed.context.flateStream('BT (Another stream) Tj ET');
      contents.push(parsed.context.register(extra));
      const bytes = extra.getContents(); bytes[0]=1; bytes[1]=2;
    } else { const bytes = stream.getContents(); bytes[0]=1; bytes[1]=2; }
    const corrupted = await parsed.save(), structure = await PDFDocument.load(corrupted);
    assert.equal(structure.getPageCount(),mode === '後続ページ' ? 2 : 1);
    assert.deepEqual(structure.getPage(0).getSize(),{width:300,height:500});
    const db = database(records()), repo = new Repository(db), before = structuredClone(db.state);
    backup.files[0].base64=Buffer.from(corrupted).toString('base64');
    await assert.rejects(repo.restoreBackup(backup),/SHA-256またはバイト長/);
    assert.deepEqual(db.state,before); assert.equal(db.observed.length,0);
    assert.equal((await importFiles([new File([corrupted],'broken.pdf',{type:'application/pdf'})])).pages.length,structure.getPageCount());
  });
}
test('REV-009: 正常な複数Contentsと本文なしページを復元・取込みできる',async () => {
  const source = await PDFDocument.create(); source.addPage([300,500]).drawText('First text'); source.addPage([300,500]);
  const parsed = await PDFDocument.load(await source.save());
  parsed.getPage(0).node.Contents().push(parsed.context.register(parsed.context.flateStream('q 1 0 0 1 0 0 cm Q')));
  const bytes = await parsed.save(), db = database(records()), repo = new Repository(db);
  await repo.restoreBackup(await createBackup(records(bytes,'application/pdf')));
  assert.deepEqual((await repo.load()).warnings,[]);
  const imported = await importFiles([new File([bytes],'valid.pdf',{type:'application/pdf'})]);
  assert.equal(imported.pages.length,2); assert.match(imported.pages[0].text,/First text/);
});


test('REV-007: バックアップは参照画像2件のみ含め順次検証し失敗時は全ストアを保持する',async () => {
  const raw=records();raw.files.push(file('second',png()),file('orphan',png()));
  raw.pages[1].background={type:'image',fileId:'second'};
  const backup=await createBackup(raw);
  assert.deepEqual(backup.files.map(f=>f.id),['asset','second']);assert.equal(backup.counts.files,2);
  const db=database(records()),repo=new Repository(db),events=[];let active=0;
  await repo.restoreBackup(backup,{decode:async()=>{assert.equal(active++,0);events.push('decode');await Promise.resolve();return {width:1,height:1,close(){active--;events.push('close');}};}});
  assert.deepEqual(events,['decode','close','decode','close']);
  const before=structuredClone(db.state);
  await assert.rejects(repo.restoreBackup(backup,{decode:async()=>{throw new Error('decode failed');}}),/decode failed/);
  assert.deepEqual(db.state,before);
});


test('USR-001: 1バイト改変・長さ変更・整合性情報欠落を拒否し既存全ストアを保持する',async()=>{
  const raw=records();raw.folders.push({id:'f',name:'keep',order:0,createdAt:1,updatedAt:1});raw.notebooks[0].folderId='f';
  const backup=await createBackup(raw),db=database(raw),repo=new Repository(db),before=structuredClone(db.state);
  for(const mutate of [
    b=>{const bytes=Buffer.from(b.files[0].base64,'base64');bytes[bytes.length-1]^=1;b.files[0].base64=bytes.toString('base64');},
    b=>{b.files[0].base64=Buffer.from(b.files[0].base64,'base64').subarray(0,-1).toString('base64');},
    b=>{b.files[0].byteLength++;},b=>{delete b.files[0].sha256;},b=>{delete b.files[0].byteLength;},b=>{b.files[0].sha256='0'.repeat(64);}
  ]) {
    const bad=structuredClone(backup);mutate(bad);await assert.rejects(repo.restoreBackup(bad),/SHA-256/);
    assert.deepEqual(db.state,before);assert.equal(db.observed.length,0);
  }
  const legacy=structuredClone(backup);legacy.version=1;delete legacy.files[0].sha256;delete legacy.files[0].byteLength;
  await repo.restoreBackup(legacy);assert.deepEqual(db.state,before);
  db.observed.length=0;
  const badLegacy=structuredClone(legacy);badLegacy.files[0].base64=Buffer.from('broken PNG').toString('base64');
  await assert.rejects(repo.restoreBackup(badLegacy),/PNG/);assert.deepEqual(db.state,before);assert.equal(db.observed.length,0);
});


test('USR-001: 後続ファイルのハッシュ不一致なら前のファイルもデコードせず全ストアを保持する',async()=>{
  const raw=records(),db=database(raw),repo=new Repository(db),before=structuredClone(db.state);
  raw.files.push(file('second',png()));raw.pages[1].background={type:'image',fileId:'second'};
  const backup=await createBackup(raw),bytes=Buffer.from(backup.files[1].base64,'base64');bytes[bytes.length-1]^=1;backup.files[1].base64=bytes.toString('base64');
  let decodes=0;
  await assert.rejects(repo.restoreBackup(backup,{decode:async()=>{decodes++;throw new Error('must not decode');}}),/SHA-256またはバイト長/);
  assert.equal(decodes,0);assert.deepEqual(db.state,before);assert.equal(db.observed.length,0);
});

test('USR-001: 復元の後続ページ演算子取得失敗でも書込みを始めず全ストアを保持する',async()=>{
  const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();
  const backup=await createBackup(records(await pdf.save(),'application/pdf'));
  const db=database(records()),repo=new Repository(db),before=structuredClone(db.state),events=[];
  await assert.rejects(repo.restoreBackup(backup,{openPdf:async()=>({numPages:2,getPage:async n=>({getViewport:()=>({width:300,height:500}),getOperatorList:async()=>{events.push(n);if(n===2)throw new Error('bad operators');},cleanup:()=>events.push('clean'+n)}),destroy:async()=>events.push('destroy')})}),/bad operators/);
  assert.deepEqual(events,[1,'clean1',2,'clean2','destroy']);assert.deepEqual(db.state,before);assert.equal(db.observed.length,0);
});
