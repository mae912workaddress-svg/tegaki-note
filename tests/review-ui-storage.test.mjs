import test from 'node:test';
import assert from 'node:assert/strict';
import { mountEditor } from '../src/ui/editor.js';
import { mountLibrary,newNotebookDialog } from '../src/ui/library.js';
import { createNotebook } from '../src/model/notebooks.js';
import { duplicateNotebook, addPage, removePage } from '../src/model/notebooks.js';
import { Repository } from '../src/storage/db.js';
import { createLocks } from './helpers/20261118-locks.mjs';
import { createBackup, prepareBackupRestore } from '../src/storage/backup.js';
import { PDFDocument } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import { createNavigation } from '../src/navigation.js';
import { EDITING_LOCK } from '../src/storage/db.js';
import { History } from '../src/model/history.js';

// Small event/DOM double exercises the real UI handlers without a browser dependency.
// Canvas pixels, layout and Safari gestures still require real-device acceptance.
class Node {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.style={};this.listeners={};this.className='';this.value='';this.scrollTop=0;this.scrollLeft=0;this.clientWidth=1024;this.clientHeight=768;this.width=1;this.height=1;this.classList={toggle:(name,on)=>{const words=new Set(this.className.split(' '));if(on)words.add(name);else words.delete(name);this.className=[...words].join(' ');}};}
  setAttribute(k,v){this.attributes[k]=v;if(k==='value')this.value=String(v);if(k==='hidden')this.hidden=true;if(k.startsWith('data-'))this.dataset[k.slice(5)]=v;}
  getAttribute(k){return this.attributes[k];}
  append(...nodes){for(const node of nodes){this.children.push(node);if(typeof node==='object')node.parent=this;}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  set textContent(value){this.children=[String(value)];}
  get textContent(){return this.children.map(c=>typeof c==='object'?c.textContent:c).join('');}
  addEventListener(name,fn,options={}){(this.listeners[name]??=[]).push(fn);options.signal?.addEventListener('abort',()=>{this.listeners[name]=this.listeners[name].filter(f=>f!==fn);},{once:true});}
  async emit(type,patch={}){const event={target:this,preventDefault(){},button:0,...patch};for(const fn of this.listeners[type]||[])await fn(event);}
  click(){return this.emit('click');}
  matches(selector){return selector.split(',').includes(this.tagName);}
  closest(selector){return selector.startsWith('.')&&this.className.split(' ').includes(selector.slice(1))?this:this.parent?.closest(selector);}
  getBoundingClientRect(){return {left:0,top:24,right:1024,bottom:900,width:1024,height:876};}
  get offsetTop(){return 24;}
  get isConnected(){return true;}
  setPointerCapture(id){this.pointer=id;}
  hasPointerCapture(id){return this.pointer===id;}
  releasePointerCapture(){this.pointer=null;}
  showModal(){}
  close(){}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
  reportValidity(){return true;}
  getContext(){if(!this.ctx)this.ctx=new Proxy({canvas:this,measureText:text=>({width:[...text].length*10})},{get:(target,key)=>target[key]??(()=>{})});return this.ctx;}
}
const all=node=>[node,...node.children.filter(n=>typeof n==='object').flatMap(all)];
const find=(node,label)=>all(node).find(n=>n.tagName==='button'&&n.textContent===label);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function withDOM(action){
  const replacements={document:Object.assign(new Node('document'),{body:new Node('body'),createElement:tag=>new Node(tag)}),window:new Node('window'),requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,IntersectionObserver:class{observe(){}unobserve(){}disconnect(){}},Image:class{naturalWidth=1;naturalHeight=1;async decode(){}},confirm:()=>true};
  const old=Object.fromEntries(Object.keys(replacements).map(k=>[k,globalThis[k]]));Object.assign(globalThis,replacements);
  try{await action();}finally{for(const [key,value]of Object.entries(old))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
}

// Only the browser's event/IndexedDB transport is substituted. Production UI,
// Repository transactions, PDF parser, validation and reference collection run unchanged.
function memoryDB(raw) {
  const state=Object.fromEntries(['folders','notebooks','pages','files'].map(s=>[s,new Map(raw[s].map(v=>[v.id,structuredClone(v)]))]));
  const observed=[];
  let failDelete=false;
  return {state,observed,set failDelete(value){failDelete=value;},transaction(stores,mode){
    const draft=structuredClone(state), operations=[],entry={stores,mode,operations};observed.push(entry);
    let aborted=false,finished=false,pending=0;
    const tx={error:null,abort(){if(aborted)return;aborted=true;queueMicrotask(()=>tx.onabort?.());},objectStore(store){
      assert.ok(stores.includes(store));
      const request=(kind,action)=>{
        if(finished)throw new Error('TransactionInactiveError');
        const req={};pending++;operations.push([store,kind]);
        queueMicrotask(()=>{
          try {if(!aborted){req.result=action();req.onsuccess?.();}}
          catch(error){tx.error=error;tx.abort();}
          finally{pending--;}
        });return req;
      };
      return {
        get:id=>request('get',()=>structuredClone(draft[store].get(id))),
        getAll:()=>request('getAll',()=>structuredClone([...draft[store].values()])),
        put:value=>request('put',()=>draft[store].set(value.id,structuredClone(value))),
        add:value=>request('add',()=>{if(draft[store].has(value.id))throw new Error('ConstraintError');draft[store].set(value.id,structuredClone(value));}),
        delete:id=>request('delete',()=>{if(failDelete&&store==='files')throw new Error('DeleteFailure');draft[store].delete(id);}),
        clear:()=>request('clear',()=>draft[store].clear())
      };
    }};
    setImmediate(()=>{
      assert.equal(pending,0);finished=true;if(aborted)return;
      for(const store of stores)state[store]=draft[store];tx.oncomplete?.();
    });return tx;
  }};
}
// Valid 1×1 PNG, including the IDAT CRC (efa2a75b).
const pngBytes=()=>Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');

for (const resume of ['Undo','pageshow','visibilitychange','focus']) {
  test(`REV-007: ロック喪失→別タブ回収→${resume}で欠損履歴を通知・除去しUndo保存とreleaseを完了する`, () => withDOM(async () => {
    const raw=imageRecords(), db=memoryDB(raw), locks=createLocks(), tabA=locks.client();
    // A second asset remains in the current page and must survive collection.
    raw.files.push(fileRecord('current',pngBytes(),'image/png'));
    raw.pages[0].background={type:'image',fileId:'current'};
    db.state.files.set('current',structuredClone(raw.files[1]));
    db.state.pages.set(raw.pages[0].id,structuredClone(raw.pages[0]));
    const a=new Repository(db,tabA), b=new Repository(db,locks.client()), root=new Node(), notices=[];
    const cleanup=mountEditor(root,a,raw.notebooks[0],raw.pages,{back:async()=>{},report:message=>notices.push(message)});
    await settle(); await find(root,'選択').click();
    const stack=all(root).find(n=>n.className==='page-stack'), shell=all(root).find(n=>n.dataset.page);
    const point={target:shell,pointerType:'pen',pointerId:1,clientX:30,clientY:54,pressure:.5};
    await stack.emit('pointerdown',point); await stack.emit('pointerup',point);
    await find(root,'選択を削除').click(); await find(root,'再保存').click();
    tabA.close(new DOMException('suspended','AbortError')); await settle();
    await b.collectFiles(); assert.equal(db.state.files.has('image'),false); assert.equal(db.state.files.has('current'),true);
    if (resume==='pageshow') await window.emit('pageshow',{persisted:true});
    if (resume==='visibilitychange') { document.visibilityState='visible'; await document.emit('visibilitychange'); }
    if (resume==='focus') await window.emit('focus');
    await find(root,'↶ 戻す').click(); await find(root,'再保存').click();
    assert.equal(raw.pages[0].items.length,0); assert.equal(find(root,'↶ 戻す').disabled,true);
    assert.deepEqual(notices,['バックグラウンド中に一部の取り消し履歴が使えなくなりました']);
    assert.equal((await a.load()).warnings.length,0);
    // A's reacquired shared lock protects newly undoable files from B again.
    const page={...raw.pages[0],items:[{id:'again',type:'image',fileId:'again',x:1,y:1,w:1,h:1}]};
    await a.savePageWithFile(page,fileRecord('again',pngBytes(),'image/png'));
    await a.savePage(raw.pages[0]); await b.collectFiles(); assert.equal(db.state.files.has('again'),true);
    await cleanup(); assert.equal(a.editingFiles.size,0);
    await locks.client().requestLock(EDITING_LOCK,{mode:'exclusive',ifAvailable:true},lock=>assert.ok(lock));
    assert.equal(db.state.files.has('again'),false); assert.equal(db.state.files.has('current'),true);
  }));
}

for (const error of [undefined,new DOMException('suspended','AbortError')]) {
  test(`REV-007: 取得後の${error ? 'AbortError' : '予期しない正常終了'}を検知しreleaseが例外なくセッションを終了する`,async()=>{
    const locks=createLocks(), tab=locks.client(), repo=new Repository(memoryDB(imageRecords()),tab);
    const session=repo.retainEditingFiles(); await session.ready;
    tab.close(error); await settle(); assert.equal(session.lost,true);
    await session.release(); await session.release(); assert.equal(repo.editingFiles.size,0);
    await locks.client().requestLock(EDITING_LOCK,{mode:'exclusive',ifAvailable:true},lock=>assert.ok(lock));
  });
}

test('REV-007: 再取得の前後で履歴を確認し取得待ち中に回収されたUndo/Redoだけ除く',async()=>{
  const raw=imageRecords(), db=memoryDB(raw), locks=createLocks(), tab=locks.client();
  const repo=new Repository(db,tab), collector=new Repository(db,locks.client()), session=repo.retainEditingFiles(), h=new History();
  await session.ready; const empty={...raw.pages[0],items:[]};
  h.past=[structuredClone(raw.pages[0]),structuredClone(empty)]; h.future=[structuredClone(raw.pages[0]),structuredClone(empty)];
  await repo.savePage(empty); tab.close(new DOMException('suspended','AbortError')); await settle();
  let acquired, unlock; const entered=new Promise(resolve=>{acquired=resolve;});
  const exclusive=locks.client().requestLock(EDITING_LOCK,{mode:'exclusive'},async()=>{acquired();await new Promise(resolve=>{unlock=resolve;});});
  await entered;
  let checks=0;
  session.setRecoveryHandler(async()=>{
    checks++; h.removeMissingFiles(await repo.existingFileIds());
    if(checks===1){await collector.transaction(['pages','files'],tx=>collector.collectUnreferenced(tx)); unlock();}
  });
  await session.ensure(); await exclusive;
  assert.equal(checks,2); assert.deepEqual(h.past,[empty]); assert.deepEqual(h.future,[empty]);
  await repo.savePage(h.undo(empty)); await session.release(); assert.equal(repo.editingFiles.size,0);
});

test('REV-010: 読込み中の連続タップは最後のノートだけを表示し一覧復帰後のセッションが0件になる',()=>withDOM(async()=>{
  const first=createNotebook({name:'最初'}), second=createNotebook({name:'最後'});
  const raw={folders:[],notebooks:[first.notebook,second.notebook],pages:[...first.pages,...second.pages],files:[]};
  const locks=createLocks(), repo=new Repository(memoryDB(raw),locks.client()), root=new Node(), shown=[];
  let unblock, entered; const waiting=new Promise(resolve=>{entered=resolve;}); let loads=0;
  const nav=createNavigation({root,repository:repo,report:message=>assert.fail(message),
    load:async()=>{if(++loads===1){entered();await new Promise(resolve=>{unblock=resolve;});}return repo.load();},
    mountLibrary,mountEditor(...args){shown.push(args[2].name);return mountEditor(...args);}});
  const a=nav.openNotebook(first.notebook.id); await waiting; assert.equal(repo.editingFiles.size,1);
  const skipped=nav.openNotebook(first.notebook.id), last=nav.openNotebook(second.notebook.id,second.pages[0].id);
  unblock(); await Promise.all([a,skipped,last]);
  assert.deepEqual(shown,['最後']); assert.equal(repo.editingFiles.size,1); assert.match(root.textContent,/最後/);
  await nav.library(); assert.equal(repo.editingFiles.size,0);
  await locks.client().requestLock(EDITING_LOCK,{mode:'exclusive',ifAvailable:true},lock=>assert.ok(lock));
}));

test('REV-010: 読込み中の一覧要求と読込み失敗でも未採用セッションを解放し次の遷移が成功する',()=>withDOM(async()=>{
  const raw=imageRecords(), locks=createLocks(), repo=new Repository(memoryDB(raw),locks.client()), root=new Node();
  let unblock, entered, fail=false; const waiting=new Promise(resolve=>{entered=resolve;}); let loads=0;
  const nav=createNavigation({root,repository:repo,mountLibrary,mountEditor,report:()=>{},load:async()=>{
    if(++loads===1){entered();await new Promise(resolve=>{unblock=resolve;});}
    if(fail)throw new Error('load failed');return repo.load();
  }});
  const open=nav.openNotebook(raw.notebooks[0].id); await waiting; const back=nav.library(); unblock();
  await Promise.all([open,back]); assert.equal(repo.editingFiles.size,0);
  fail=true; await assert.rejects(nav.openNotebook(raw.notebooks[0].id),/load failed/); assert.equal(repo.editingFiles.size,0);
  fail=false; await nav.openNotebook(raw.notebooks[0].id); await nav.library(); assert.equal(repo.editingFiles.size,0);
}));

test('REV-010: 未採用セッションは回収失敗時にも共有ロックを残さない',async()=>{
  const raw=imageRecords(), db=memoryDB(raw), locks=createLocks(), repo=new Repository(db,locks.client());
  db.state.pages.get(raw.pages[0].id).items=[]; db.failDelete=true;
  const nav=createNavigation({root:{},repository:repo,load:async()=>{throw new Error('load failed');},mountLibrary:()=>()=>{},mountEditor:()=>assert.fail('must not mount'),report:()=>{}});
  await assert.rejects(nav.openNotebook(raw.notebooks[0].id),/load failed/);
  assert.equal(repo.editingFiles.size,0);
  await locks.client().requestLock(EDITING_LOCK,{mode:'exclusive',ifAvailable:true},lock=>assert.ok(lock));
  db.failDelete=false; await repo.collectFiles(); assert.equal(db.state.files.size,0);
});
const fileRecord=(id,bytes,mime)=>({id,name:id,mime,blob:new Blob([bytes],{type:mime})});
function imageRecords(){
  const n=createNotebook();n.pages[0].items=[{id:'item',type:'image',fileId:'image',x:10,y:10,w:100,h:100}];
  return {folders:[],notebooks:[n.notebook],pages:n.pages,files:[fileRecord('image',pngBytes(),'image/png')]};
}
async function pdfBackup(){
  const n=createNotebook(),pdf=await PDFDocument.create();pdf.addPage([300,500]).drawText('Original PDF');
  n.pages[0].background={type:'pdf',fileId:'pdf',pageIndex:0};
  return createBackup({folders:[],notebooks:[n.notebook],pages:n.pages,files:[fileRecord('pdf',await pdf.save(),'application/pdf')]});
}
test('REV-001: 正常PDFのbase64をnot a PDFに交換すると置換前に拒否し全ストアを保持する',async()=>{
  const backup=await pdfBackup(),db=memoryDB(imageRecords()),repo=new Repository(db),before=structuredClone(db.state);
  backup.files[0].base64=Buffer.from('not a PDF').toString('base64');
  await assert.rejects(repo.restoreBackup(backup),/ファイル.*読めません/);
  assert.equal(db.observed.length,0);assert.deepEqual(db.state,before);
});
test('REV-001: 実1ページPDFのpageIndex 999を置換前に拒否し全ストアを保持する',async()=>{
  const backup=await pdfBackup(),db=memoryDB(imageRecords()),repo=new Repository(db),before=structuredClone(db.state);
  backup.pages[0].background.pageIndex=999;
  await assert.rejects(repo.restoreBackup(backup),/ページ参照が範囲外/);
  assert.equal(db.observed.length,0);assert.deepEqual(db.state,before);
});
test('REV-001: 不正JPEG・PNGと寸法欠落を置換前に拒否し正常PDF・PNGは復元できる',async()=>{
  const raw=imageRecords(),valid=await createBackup(raw),db=memoryDB(raw),repo=new Repository(db),before=structuredClone(db.state);
  for(const mime of ['image/jpeg','image/png'])for(const bytes of [Buffer.from('not an image'),mime==='image/png'?pngBytes().subarray(0,20):new Uint8Array([255,216,255,217])]){
    const backup=structuredClone(valid);backup.files[0].mime=mime;backup.files[0].base64=Buffer.from(bytes).toString('base64');
    await assert.rejects(repo.restoreBackup(backup),/ファイル.*読めません/);
    assert.equal(db.observed.length,0);assert.deepEqual(db.state,before);
  }
  const badCRC=structuredClone(valid),broken=pngBytes();broken[broken.length-17]^=1;
  badCRC.files[0].base64=broken.toString('base64');
  await assert.rejects(repo.restoreBackup(badCRC),/ファイル.*読めません/);
  assert.equal(db.observed.length,0);assert.deepEqual(db.state,before);
  await repo.restoreBackup(valid);assert.equal(db.state.files.size,1);
  const pdf=await pdfBackup();await repo.restoreBackup(pdf);assert.equal(db.state.files.size,1);
  assert.deepEqual([...db.state.pages.values()][0].background,pdf.pages[0].background);
  assert.deepEqual(db.observed.map(t=>t.stores),Array(2).fill(['folders','notebooks','pages','files']));
});
test('REV-001: 実一覧UIの復元エラー表示と既存データ保持',()=>withDOM(async()=>{
  const raw=imageRecords(),db=memoryDB(raw),repo=new Repository(db),root=new Node(),errors=[],backup=await pdfBackup();
  backup.pages[0].background.pageIndex=999;
  const before=structuredClone(db.state),cleanup=mountLibrary(root,repo,{...raw,warnings:[]},{openNotebook:async()=>{},reload:async()=>{throw new Error('must not reload');},report:e=>errors.push(e)});
  try{
    const picker=all(root).find(n=>n.getAttribute('accept')==='application/json,.json');
    picker.files=[new File([JSON.stringify(backup)],'bad.json')];await picker.emit('change');
    assert.match(errors[0],/ページ参照が範囲外/);assert.equal(db.observed.length,0);assert.deepEqual(db.state,before);
  }finally{cleanup();}
}));
test('REV-002: 実mountEditorで部分を消すを選び長い線の中央を消すと左右2本が残る',()=>withDOM(async()=>{
  const n=createNotebook(),root=new Node(),errors=[];
  const cleanup=mountEditor(root,{savePage:async()=>{}},n.notebook,n.pages,{back:async()=>{},report:e=>errors.push(e)});
  try{
    const stack=all(root).find(n=>n.className==='page-stack'),shell=all(root).find(n=>n.dataset.page);
    const point=(x,y,id=1)=>({target:shell,pointerType:'pen',pointerId:id,clientX:x*1.2,clientY:y*1.2+24,pressure:.5});
    await stack.emit('pointerdown',point(40,100));await stack.emit('pointerup',point(400,100));
    assert.equal(n.pages[0].strokes.length,1);
    await find(root,'消しゴム').click();const select=all(root).find(n=>n.getAttribute('aria-label')==='消しゴム方式');
    select.value='partial';await select.emit('change');
    await stack.emit('pointerdown',point(220,100,2));await stack.emit('pointerup',point(220,100,2));
    const strokes=n.pages[0].strokes;assert.equal(strokes.length,2);
    assert.equal(strokes[0].points[0][0],40);assert.ok(strokes[0].points.at(-1)[0]<220);
    assert.ok(strokes[1].points[0][0]>220);assert.equal(strokes[1].points.at(-1)[0],400);
    await find(root,'↶ 戻す').click();assert.equal(n.pages[0].strokes.length,1);
    await find(root,'↷ やり直す').click();assert.equal(n.pages[0].strokes.length,2);
    assert.deepEqual(errors,[]);
  }finally{cleanup();}
}));
test('REV-005: 唯一の参照ノート削除でfilesが0件になりバックアップにも残らない',async()=>{
  const backup=await pdfBackup(),raw=await prepareBackupRestore(backup),db=memoryDB(raw),repo=new Repository(db,createLocks().client());
  await repo.deleteNotebook(raw.notebooks[0]);assert.equal(db.state.files.size,0);assert.equal(db.state.pages.size,0);
  const deletions=db.observed.filter(t=>t.operations.some(([store,kind])=>store==='notebooks'&&kind==='delete'));
  assert.equal(deletions.length,1);assert.equal(deletions[0].mode,'readwrite');
  assert.deepEqual([...deletions[0].stores].sort(),['files','notebooks','pages']);
  for(const store of ['pages','files'])assert.ok(deletions[0].operations.some(([s,kind])=>s===store&&kind==='delete'));
  const result=await createBackup(await repo.load());assert.equal(result.files.length,0);assert.equal(result.counts.files,0);
});
test('REV-005: 複製元を削除しても複製先が共有するPDF・画像を残す',async()=>{
  const raw=await prepareBackupRestore(await pdfBackup());
  raw.files.push(fileRecord('image',pngBytes(),'image/png'));raw.pages[0].items=imageRecords().pages[0].items;
  const db=memoryDB(raw),repo=new Repository(db,createLocks().client()),copy=duplicateNotebook(raw.notebooks[0],raw.pages);
  await repo.saveNotebook(copy.notebook,copy.pages);await repo.deleteNotebook(raw.notebooks[0]);
  assert.equal(db.state.files.size,2);
  const backup=await createBackup(await repo.load());assert.equal(backup.files.length,2);
  assert.equal((await prepareBackupRestore(backup)).notebooks[0].id,copy.notebook.id);
  await repo.deleteNotebook(copy.notebook);assert.equal(db.state.files.size,0);
});
test('REV-005: ページ削除時に編集中の回収を延期し終了時に最後の参照だけ回収する',async()=>{
  const raw=imageRecords(),added=addPage(raw.notebooks[0],raw.pages);
  added.page.items=structuredClone(raw.pages[0].items);
  const third=addPage(added.notebook,added.pages);raw.notebooks=[third.notebook];raw.pages=third.pages;
  const db=memoryDB(raw),repo=new Repository(db,createLocks().client()),lease=repo.retainEditingFiles(raw.pages);
  const removed=removePage(raw.notebooks[0],raw.pages,raw.pages[0].id);
  await repo.saveNotebook(removed.notebook,[],[raw.pages[0].id]);
  assert.equal(db.state.files.size,1);
  const pageDeletions=()=>db.observed.filter(t=>t.operations.some(([store,kind])=>store==='pages'&&kind==='delete'));
  assert.equal(pageDeletions().length,1);
  const last=removePage(removed.notebook,removed.pages,added.page.id);
  await repo.saveNotebook(last.notebook,[],[added.page.id]);assert.equal(db.state.files.size,1);
  const deletions=pageDeletions();assert.equal(deletions.length,2);
  for(const tx of deletions){
    assert.equal(tx.mode,'readwrite');assert.deepEqual([...tx.stores].sort(),['files','notebooks','pages']);
    assert.ok(tx.operations.some(([store,kind])=>store==='notebooks'&&kind==='put'));
    assert.ok(!tx.operations.some(([store,kind])=>store==='files'&&kind==='getAll'));
  }
  assert.ok(!deletions[0].operations.some(([store,kind])=>store==='files'&&kind==='delete'));
  assert.ok(!deletions[1].operations.some(([store,kind])=>store==='files'&&kind==='delete'));
  await lease.release();assert.equal(db.state.files.size,0);
});
test('REV-005: ファイル削除失敗はノート・ページの削除もロールバックする',async()=>{
  const raw=imageRecords(),db=memoryDB(raw),repo=new Repository(db,createLocks().client()),before=structuredClone(db.state);db.failDelete=true;
  await assert.rejects(repo.deleteNotebook(raw.notebooks[0]),/DeleteFailure/);assert.deepEqual(db.state,before);
});
test('REV-005: 実編集UIで画像削除・保存・Undo後も本体があり閉じる時に不要分を回収する',()=>withDOM(async()=>{
  const raw=imageRecords(),db=memoryDB(raw),repo=new Repository(db,createLocks().client()),root=new Node(),errors=[];
  const cleanup=mountEditor(root,repo,raw.notebooks[0],raw.pages,{back:async()=>{},report:e=>errors.push(e)});
  try{
    await settle();
    await find(root,'選択').click();const stack=all(root).find(n=>n.className==='page-stack'),shell=all(root).find(n=>n.dataset.page);
    const point={target:shell,pointerType:'pen',pointerId:1,clientX:30,clientY:54,pressure:.5};
    await stack.emit('pointerdown',point);await stack.emit('pointerup',point);
    await find(root,'選択を削除').click();await find(root,'再保存').click();
    assert.equal(raw.pages[0].items.length,0);assert.equal(db.state.files.size,1);
    await find(root,'↶ 戻す').click();await find(root,'再保存').click();
    assert.equal(raw.pages[0].items.length,1);assert.equal((await repo.getFile('image')).blob.size,pngBytes().length);
    await find(root,'↷ やり直す').click();await find(root,'再保存').click();
    assert.equal(db.state.files.size,1);
  }finally{await cleanup();}
  assert.deepEqual(errors,[]);assert.equal(db.state.files.size,0);assert.equal((await createBackup(await repo.load())).files.length,0);
}));
test('REV-005: 回収失敗時は編集画面とUndoを維持し再試行できる',()=>withDOM(async()=>{
  const raw=imageRecords(),db=memoryDB(raw),repo=new Repository(db,createLocks().client()),root=new Node(),errors=[];
  const cleanup=mountEditor(root,repo,raw.notebooks[0],raw.pages,{back:async()=>{},report:e=>errors.push(e)});
  await settle();await find(root,'選択').click();
  const stack=all(root).find(n=>n.className==='page-stack'),shell=all(root).find(n=>n.dataset.page);
  const point={target:shell,pointerType:'pen',pointerId:1,clientX:30,clientY:54,pressure:.5};
  await stack.emit('pointerdown',point);await stack.emit('pointerup',point);
  await find(root,'選択を削除').click();await find(root,'再保存').click();
  db.failDelete=true;await assert.rejects(cleanup(),/DeleteFailure/);assert.equal(db.state.files.size,1);
  await find(root,'↶ 戻す').click();assert.equal(raw.pages[0].items.length,1);
  db.failDelete=false;await cleanup();assert.equal(db.state.files.size,1);assert.deepEqual(errors,[]);
}));


test('REV-009: F4の実一覧UIで本文破損PDFのエラーを表示し全ストアを保持する',()=>withDOM(async()=>{
  const source=await PDFDocument.create();source.addPage().drawText('Contents');
  const parsed=await PDFDocument.load(await source.save());
  const bytes=parsed.getPage(0).node.Contents().lookup(0).getContents();bytes[0]=1;bytes[1]=2;
  const raw=imageRecords(),db=memoryDB(raw),repo=new Repository(db),root=new Node(),errors=[],before=structuredClone(db.state);
  const cleanup=mountLibrary(root,repo,{...raw,warnings:[]},{openNotebook:async()=>{throw new Error('must not open');},reload:async()=>{},report:e=>errors.push(e)});
  try{
    const picker=all(root).find(n=>n.getAttribute('accept')==='application/pdf,image/jpeg');
    picker.files=[new File([await parsed.save()],'broken.pdf',{type:'application/pdf'})];await picker.emit('change');
    assert.match(errors[0],/本文ストリームを展開できません/);assert.equal(db.observed.length,0);assert.deepEqual(db.state,before);
  }finally{cleanup();}
}));
