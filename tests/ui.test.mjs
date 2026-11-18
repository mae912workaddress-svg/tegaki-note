import test from 'node:test';
import assert from 'node:assert/strict';
import { mountEditor } from '../src/ui/editor.js';
import { mountLibrary,newNotebookDialog } from '../src/ui/library.js';
import { createNotebook } from '../src/model/notebooks.js';
import { strokeOutline } from '../src/render/strokes.js';
import { renderPage } from '../src/render/page.js';
import { sampledCanvas, over } from './helpers/20261119-sampled-canvas.mjs';

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
function animationFrames() {
  const jobs=new Map();let id=0;
  globalThis.requestAnimationFrame=fn=>{jobs.set(++id,fn);return id;};
  globalThis.cancelAnimationFrame=id=>jobs.delete(id);
  return ()=>{const pending=[...jobs.values()];jobs.clear();pending.forEach(fn=>fn());};
}
function inkLayers(shell) {
  const layers={base:[],live:[]};
  shell.children.filter(n=>n.tagName==='canvas').forEach((canvas,index)=>{
    const name=index?'live':'base',ctx=canvas.getContext();let path=[];
    ctx.clearRect=()=>{layers[name]=[];};
    ctx.beginPath=()=>{path=[];};
    ctx.moveTo=ctx.lineTo=(...p)=>path.push(p);
    ctx.fill=()=>{if(path.length)layers[name].push(structuredClone(path));};
  });
  return layers;
}
function outlineWidth(outline,x) {
  const ys=[];
  for(let i=0;i<outline.length;i++) {
    const a=outline[i],b=outline[(i+1)%outline.length];
    if((a[0]<=x&&x<b[0])||(b[0]<=x&&x<a[0])) ys.push(a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]));
  }
  return ys.length?Math.max(...ys)-Math.min(...ys):0;
}
async function withDOM(action){
  const replacements={document:Object.assign(new Node('document'),{body:new Node('body'),createElement:tag=>new Node(tag)}),window:new Node('window'),requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,IntersectionObserver:class{observe(){}unobserve(){}disconnect(){}},confirm:()=>true};
  const old=Object.fromEntries(Object.keys(replacements).map(k=>[k,globalThis[k]]));Object.assign(globalThis,replacements);
  try{await action();}finally{for(const [key,value]of Object.entries(old))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
}
test('新規シートは空欄から入力でき、空欄作成は新しいノートになる',()=>withDOM(async()=>{
  const pending=newNotebookDialog(null),input=all(document.body).find(n=>n.tagName==='input');assert.equal(input.value,'');assert.equal(input.getAttribute('placeholder'),'新しいノート');
  await find(document.body,'作成').click();assert.equal((await pending).notebook.name,'新しいノート');
}));
test('編集UIでツール説明・テキスト追加/移動/削除・Undo/Redo・しおり・保存が動く',()=>withDOM(async()=>{
  const root=new Node(),n=createNotebook(),errors=[],writes=[];
  const cleanup=mountEditor(root,{savePage:async p=>writes.push(p)},n.notebook,n.pages,{back:async()=>{},report:message=>errors.push(message)});
  try{
    const help=all(root).find(n=>n.className==='selection-help');assert.match(help.textContent,/ペン：/);
    await find(root,'投げなわ').click();assert.match(help.textContent,/投げなわ：/);
    await find(root,'テキスト').click();const stack=all(root).find(n=>n.className==='page-stack'),shell=all(root).find(n=>n.dataset.page);
    await stack.emit('pointerdown',{target:shell,pointerType:'pen',pointerId:1,clientX:100,clientY:100,pressure:.5});
    const input=all(document.body).find(n=>n.tagName==='textarea');assert.ok(input);input.value='日本語テキスト';await find(document.body,'保存').click();await settle();
    assert.equal(n.pages[0].items.length,1);assert.equal(n.pages[0].items[0].text,'日本語テキスト');assert.match(help.textContent,/選択：/);
    await find(root,'↶ 戻す').click();assert.equal(n.pages[0].items.length,0);await find(root,'↷ やり直す').click();assert.equal(n.pages[0].items.length,1);
    const item=n.pages[0].items[0],beforeX=item.x;
    // Initial scale is capped at 1.2.
    await stack.emit('pointerdown',{target:shell,pointerType:'touch',pointerId:2,clientX:item.x*1.2+5,clientY:item.y*1.2+29,pressure:.5});
    await stack.emit('pointerup',{target:shell,pointerType:'touch',pointerId:2,clientX:item.x*1.2+45,clientY:item.y*1.2+69,pressure:.5});
    assert.ok(n.pages[0].items[0].x>beforeX);await find(root,'選択を削除').click();assert.equal(n.pages[0].items.length,0);await find(root,'↶ 戻す').click();assert.equal(n.pages[0].items.length,1);
    await find(root,'☆ しおり').click();assert.equal(n.pages[0].bookmarked,true);await find(root,'再保存').click();assert.ok(writes.length);assert.deepEqual(errors,[]);
  }finally{cleanup();}
}));
test('一覧UIでPDF文字の検索結果を押すと該当ページを開く',()=>withDOM(async()=>{
  const root=new Node(),n=createNotebook(),opened=[];n.pages[0].text='ＰＤＦの文字';
  const cleanup=mountLibrary(root,{}, {folders:[],notebooks:[n.notebook],pages:n.pages,files:[]},{openNotebook:async(...args)=>opened.push(args),reload:async()=>{},report:message=>{throw new Error(message);}});
  try{const search=all(root).find(n=>n.getAttribute('type')==='search');search.value='pdf';await search.emit('input');const result=all(root).find(n=>n.className==='search-result');assert.ok(result);await result.click();assert.deepEqual(opened,[[n.notebook.id,n.pages[0].id]]);}finally{cleanup();}
}));
test('ページパネルの複製・上下移動・しおり絞り込みが実UIから保存される',()=>withDOM(async()=>{
  const root=new Node(),n=createNotebook(),saved=[],errors=[];
  const cleanup=mountEditor(root,{savePage:async()=>{},saveNotebook:async(book,pages)=>saved.push(structuredClone({book,pages}))},n.notebook,n.pages,{back:async()=>{},report:e=>errors.push(e)});
  try{
    const pending=find(root,'ページ一覧').click();await settle();await find(document.body,'複製').click();
    assert.equal(saved.at(-1).book.pageIds.length,2);const order=saved.at(-1).book.pageIds;
    await find(document.body,'↓').click();assert.deepEqual(saved.at(-1).book.pageIds,[...order].reverse());
    const filter=all(document.body).find(n=>n.tagName==='input');filter.checked=true;await filter.emit('change');assert.match(document.body.textContent,/しおりの付いたページはありません/);
    await find(document.body,'閉じる').click();await pending;assert.deepEqual(errors,[]);
  }finally{cleanup();}
}));


test('USR-002/003: 実UIでcoalesced入力を毎フレーム全消去・再描画し、確定時も同一輪郭で残像を消す',()=>withDOM(async()=>{
  const scheduled=new Map();let next=0;
  globalThis.requestAnimationFrame=fn=>{scheduled.set(++next,fn);return next;};
  globalThis.cancelAnimationFrame=id=>scheduled.delete(id);
  const flush=()=>{const jobs=[...scheduled.values()];scheduled.clear();jobs.forEach(fn=>fn());};
  const root=new Node(),n=createNotebook(),errors=[];
  const cleanup=mountEditor(root,{savePage:async()=>{}},n.notebook,n.pages,{back:async()=>{},report:e=>errors.push(e)});
  try {
    await settle();
    const stack=all(root).find(n=>n.className==='page-stack'),shell=all(root).find(n=>n.dataset.page);
    const [base,live]=shell.children.filter(n=>n.tagName==='canvas'),trace=[];
    for(const [name,canvas] of [['base',base],['live',live]])for(const method of ['save','setTransform','clearRect','restore','beginPath','moveTo','lineTo','closePath','fill'])canvas.getContext()[method]=(...args)=>trace.push([name,method,...args]);
    const event=(x,pressure=.5)=>({target:shell,pointerType:'pen',pointerId:1,clientX:x*1.2,clientY:144,pressure});
    await stack.emit('pointerdown',event(20,.4));
    await stack.emit('pointermove',{...event(50),getCoalescedEvents:()=>[event(30),event(40),event(50)]});
    assert.equal(scheduled.size,1);assert.equal(trace.length,0);flush();
    assert.deepEqual(trace.slice(0,4),[['live','save'],['live','setTransform',1,0,0,1,0,0],['live','clearRect',0,0,live.width,live.height],['live','restore']]);
    assert.equal(trace.filter(c=>c[0]==='live'&&c[1]==='clearRect').length,1);
    trace.length=0;
    await stack.emit('pointermove',{...event(80),getCoalescedEvents:()=>[event(60),event(70),event(80)]});flush();
    assert.equal(trace.filter(c=>c[0]==='live'&&c[1]==='clearRect').length,1);
    const path=trace.filter(c=>c[0]==='live'&&['moveTo','lineTo'].includes(c[1])).map(c=>c.slice(1));
    trace.length=0;
    await stack.emit('pointerup',event(80,0));
    assert.equal(n.pages[0].strokes[0].points.length,7);assert.equal(n.pages[0].strokes[0].points.at(-1)[2],.5);
    const committed=trace.filter(c=>c[0]==='base'&&['moveTo','lineTo'].includes(c[1])).map(c=>c.slice(1));
    assert.deepEqual(committed,path);
    assert.ok(trace.findIndex(c=>c[0]==='live'&&c[1]==='clearRect')<trace.findIndex(c=>c[0]==='base'&&c[1]==='clearRect'));
    assert.equal(scheduled.size,0);
    trace.length=0;await stack.emit('pointerdown',{...event(90),pointerId:2});await stack.emit('pointercancel',{pointerId:2});
    assert.ok(trace.some(c=>c[0]==='live'&&c[1]==='clearRect'));assert.equal(scheduled.size,0);assert.equal(n.pages[0].strokes.length,2);
    await all(root).find(n=>n.getAttribute('aria-label')==='拡大').click();
    assert.equal(base.width,live.width);assert.equal(base.height,live.height);
    assert.deepEqual(errors,[]);
  }finally{cleanup();}
}));

test('USR-004/REV-001/012: 接触断を描画中から同一輪郭で連結し、pen cancel・保存・Undo/Redoでも1本として扱う',()=>withDOM(async()=>{
  const scheduled=new Map();let next=0;
  globalThis.requestAnimationFrame=fn=>{scheduled.set(++next,fn);return next;};
  globalThis.cancelAnimationFrame=id=>scheduled.delete(id);
  const flush=()=>{const jobs=[...scheduled.values()];scheduled.clear();jobs.forEach(fn=>fn());};
  const root=new Node(),n=createNotebook(),writes=[];
  const cleanup=mountEditor(root,{savePage:async page=>writes.push(structuredClone(page))},n.notebook,n.pages,{back:async()=>{},report:e=>assert.fail(e)});
  try {
    await settle();
    const stack=all(root).find(n=>n.className==='page-stack'),shell=all(root).find(n=>n.dataset.page);
    const [base,live]=shell.children.filter(n=>n.tagName==='canvas'),paths={base:[],live:[]};
    for(const [name,canvas] of [['base',base],['live',live]]) {
      canvas.getContext().clearRect=()=>{paths[name]=[];};
      for(const method of ['moveTo','lineTo']) canvas.getContext()[method]=(...p)=>paths[name].push(p);
    }
    const event=(x,timeStamp,pointerId)=>({target:shell,pointerType:'pen',pointerId,clientX:x*1.2,clientY:144,pressure:.03,timeStamp});
    for(let i=0;i<5;i++) {
      const previousPath=structuredClone(paths.base);
      await stack.emit('pointerdown',event(20+i*7,100+i*55,i+1));
      assert.deepEqual(paths.base,previousPath); // No speculative removal/merge on down.
      flush();assert.deepEqual(paths.base,previousPath);
      await stack.emit('pointermove',event(23+i*7,105+i*55,i+1));
      await stack.emit('pointermove',event(26+i*7,110+i*55,i+1));
      flush();const livePath=structuredClone(paths.live);assert.ok(livePath.length);
      assert.deepEqual(paths.base,[]); // No duplicate of the preceding stroke below the live ink.
      await stack.emit(i===2?'pointercancel':i===3?'lostpointercapture':'pointerup',{...event(26+i*7,115+i*55,i+1),pressure:0});
      assert.equal(n.pages[0].strokes.length,1);
      assert.deepEqual(paths.base,livePath);
      assert.deepEqual(paths.base,strokeOutline(n.pages[0].strokes[0]));assert.deepEqual(paths.live,[]);
    }
    const joined=structuredClone(n.pages[0].strokes);
    assert.equal(joined[0].points[0][0],20);assert.equal(joined[0].points.at(-1)[0],54);
    await find(root,'再保存').click();assert.deepEqual(writes.at(-1).strokes,joined);
    await find(root,'↶ 戻す').click();assert.equal(n.pages[0].strokes.length,0);
    await find(root,'↷ やり直す').click();assert.deepEqual(n.pages[0].strokes,joined);
    // Undo/Redo invalidates a continuation even inside the time/distance window.
    await stack.emit('pointerdown',event(55,375,6));await stack.emit('pointerup',event(61,390,6));
    assert.equal(n.pages[0].strokes.length,2);
    // 81ms and a 4pt gap each start a separate stroke.
    await stack.emit('pointerdown',event(62,471,7));await stack.emit('pointerup',event(68,486,7));
    await stack.emit('pointerdown',event(72,526,8));await stack.emit('pointerup',event(78,541,8));
    assert.equal(n.pages[0].strokes.length,4);
    await find(root,'蛍光ペン').click();
    await stack.emit('pointerdown',event(79,581,9));await stack.emit('pointerup',event(85,596,9));
    assert.equal(n.pages[0].strokes.length,5);
    await stack.emit('pointerdown',event(86,636,10));await stack.emit('pointerup',event(92,651,10));
    assert.equal(n.pages[0].strokes.length,5);
    await find(root,'↶ 戻す').click();assert.equal(n.pages[0].strokes.length,4);
  } finally {cleanup();}
}));

for(const [terminal,endTime] of [['pointerup',170],['pointercancel',170],['lostpointercapture',170],['pointerup',210]])
test(`REV-012: 指定3pt隙間は移動時から1.25pt以上で連結し${terminal}/${endTime}後も合成輪郭が一致する`,()=>withDOM(async()=>{
  const flush=animationFrames(),root=new Node(),n=createNotebook();
  const existing={id:'existing',tool:'pen',color:'#263238',size:2,points:[[10,200,.5],[40,200,.5]]};
  n.pages[0].strokes.push(existing);
  const cleanup=mountEditor(root,{savePage:async()=>{}},n.notebook,n.pages,{back:async()=>{},report:e=>assert.fail(e)});
  try {
    await settle();
    const stack=all(root).find(n=>n.className==='page-stack'),shell=all(root).find(n=>n.dataset.page);
    const layers=inkLayers(shell);
    const event=(x,timeStamp,pointerId)=>({target:shell,pointerType:'pen',pointerId,clientX:x*1.2,clientY:144,pressure:.03,timeStamp});
    await stack.emit('pointerdown',event(20,100,1));
    await stack.emit('pointermove',event(23,105,1));
    await stack.emit('pointermove',event(26,110,1));
    await stack.emit('pointerup',{...event(26,115,1),pressure:0});
    const before=structuredClone(n.pages[0].strokes),baseBefore=structuredClone(layers.base);
    await stack.emit('pointerdown',event(29,155,2));flush();
    assert.deepEqual(layers.base,baseBefore);assert.equal(layers.base.length,2);
    assert.equal(layers.live.length,1); // The new dot is independent until it moves.
    await stack.emit('pointermove',event(32,160,2));flush();
    assert.deepEqual(layers.base,[strokeOutline(existing)]);
    assert.equal(layers.live.length,1);
    assert.ok(outlineWidth(layers.live[0],27.5)>=1.25);
    await stack.emit('pointermove',event(35,165,2));flush();
    assert.deepEqual(layers.base,[strokeOutline(existing)]);
    assert.ok(outlineWidth(layers.live[0],27.5)>=1.25);
    assert.deepEqual(n.pages[0].strokes,before); // Preview does not mutate persisted content.
    const preview=structuredClone([...layers.base,...layers.live]);
    await stack.emit(terminal,{...event(35,endTime,2),pressure:0});
    assert.deepEqual(layers.base,preview);assert.deepEqual(layers.live,[]);
    assert.equal(n.pages[0].strokes.length,2);
    assert.deepEqual(layers.base,n.pages[0].strokes.map(strokeOutline));
    await find(root,'↶ 戻す').click();assert.deepEqual(n.pages[0].strokes,[existing]);
  } finally {cleanup();}
}));

test('USR-004: 別デバイス・色変更・サイズ変更・マウス入力は連結しない',()=>withDOM(async()=>{
  const root=new Node(),n=createNotebook();
  const cleanup=mountEditor(root,{savePage:async()=>{}},n.notebook,n.pages,{back:async()=>{},report:e=>assert.fail(e)});
  try {
    const stack=all(root).find(n=>n.className==='page-stack'),shell=all(root).find(n=>n.dataset.page);
    let time=0,x=20;
    const line=async(patch={})=>{
      const e={target:shell,pointerType:'pen',pointerId:1,clientX:x*1.2,clientY:144,pressure:.1,persistentDeviceId:1,...patch};
      await stack.emit('pointerdown',{...e,timeStamp:time});await stack.emit('pointerup',{...e,clientX:(x+6)*1.2,timeStamp:time+10});time+=50;x+=7;
    };
    await line();await line({persistentDeviceId:2});
    await all(root).find(n=>n.getAttribute('aria-label')==='赤').click();await line({persistentDeviceId:2});
    const sizes=all(root).find(n=>n.getAttribute('aria-label')==='ペンの太さ');sizes.value='4';await sizes.emit('change');await line({persistentDeviceId:2});
    await line({pointerType:'mouse'});await line({pointerType:'mouse'});
    assert.equal(n.pages[0].strokes.length,6);
  } finally {cleanup();}
}));

for (const [name,first,second] of [
  ['指定再現の2点',[[20,100,100],[20,100,110]],[[23,100,170],[23,100,180]]],
  ['濁点の近接2点',[[20,100,100],[20,100,110]],[[21,99,150],[21,99,160]]],
  ['句読点',[[20,100,100],[20,100,110]],[[22,100,150],[23,101,160]]],
  ['短い払いの連続',[[20,100,100],[22,100,110]],[[23,100,150],[25,100,160]]],
  ['長い線の後の点',[[20,100,100],[23,100,105],[26,100,110]],[[27,100,150],[27,100,160]]],
  ['停止して離した長い線',[[20,100,100],[26,100,110],[26,100,145]],[[27,100,185],[33,100,195]]],
  ['方向が異なる次の線',[[20,100,100],[26,100,110]],[[26,102,150],[32,102,160]]]
]) test(`REV-001: ${name}は独立しUndoは後の1本だけを消す`,()=>withDOM(async()=>{
  const flush=animationFrames();
  const root=new Node(),n=createNotebook(),writes=[];
  const cleanup=mountEditor(root,{savePage:async p=>writes.push(structuredClone(p))},n.notebook,n.pages,{back:async()=>{},report:e=>assert.fail(e)});
  try {
    await settle();
    const stack=all(root).find(n=>n.className==='page-stack'),shell=all(root).find(n=>n.dataset.page);
    const layers=inkLayers(shell);
    const stroke=async(points,pointerId)=>{
      for(let i=0;i<points.length;i++) {
        const [x,y,timeStamp]=points[i];
        const event={
          target:shell,pointerType:'pen',pointerId,clientX:x*1.2,clientY:y*1.2+24,pressure:.03,timeStamp
        };
        await stack.emit(i===0?'pointerdown':'pointermove',event);
        flush();
        assert.deepEqual(layers.base,n.pages[0].strokes.map(strokeOutline));
        assert.equal(layers.live.length,1);
        if(i===points.length-1) {
          const preview=structuredClone([...layers.base,...layers.live]);
          await stack.emit('pointerup',{...event,pressure:0});
          assert.deepEqual(layers.base,preview);
          assert.deepEqual(layers.live,[]);
        }
      }
    };
    await stroke(first,1);const original=structuredClone(n.pages[0].strokes);
    await stroke(second,2);assert.equal(n.pages[0].strokes.length,2);
    const both=structuredClone(n.pages[0].strokes);
    await find(root,'再保存').click();assert.deepEqual(writes.at(-1).strokes,both);
    await find(root,'↶ 戻す').click();assert.deepEqual(n.pages[0].strokes,original);
    await find(root,'↷ やり直す').click();assert.deepEqual(n.pages[0].strokes,both);
  } finally {cleanup();}
}));

for(const pointerType of ['touch','mouse','pen'])for(const order of ['pointer-first','touch-first','capture-first']) {
  test(`REV-002: ${pointerType} cancel ${order}は入力種別だけで保持を決める`,()=>withDOM(async()=>{
    const root=new Node(),n=createNotebook(),writes=[];
    const cleanup=mountEditor(root,{savePage:async p=>writes.push(structuredClone(p))},n.notebook,n.pages,{back:async()=>{},report:e=>assert.fail(e)});
    try {
      const stack=all(root).find(n=>n.className==='page-stack'),shell=all(root).find(n=>n.dataset.page),scroller=all(root).find(n=>n.className==='page-scroller');
      const finger=all(root).find(n=>n.getAttribute('type')==='checkbox');finger.checked=true;await finger.emit('change');
      const event={target:shell,pointerType,pointerId:1,clientX:24,clientY:144,pressure:.1,timeStamp:100};
      await stack.emit('pointerdown',event);
      await stack.emit('pointermove',{...event,clientX:36,timeStamp:110});
      const cancel=()=>stack.emit(order==='capture-first'?'lostpointercapture':'pointercancel',{...event,timeStamp:115});
      const touchCancel=()=>scroller.emit('touchcancel',{touches:[],timeStamp:115});
      if(order==='touch-first') {await touchCancel();await cancel();}else {await cancel();await touchCancel();}
      // Late pointerup/lostcapture must not resurrect or duplicate cancelled ink.
      await stack.emit('pointerup',{...event,timeStamp:120});await stack.emit('lostpointercapture',event);
      assert.equal(n.pages[0].strokes.length,pointerType==='pen'?1:0);
      await find(root,'再保存').click();
      assert.equal(writes.length,pointerType==='pen'?1:0);
      if(pointerType==='pen') {assert.equal(writes[0].strokes.length,1);await find(root,'↶ 戻す').click();assert.equal(n.pages[0].strokes.length,0);}
      else assert.equal(find(root,'↶ 戻す').disabled,true);
    } finally {cleanup();}
  }));
}

for(const start of ['scroll','pinch'])test(`REV-002: ${start}開始でキャンセルされた指の線は残らない`,()=>withDOM(async()=>{
  const root=new Node(),n=createNotebook(),writes=[];
  const cleanup=mountEditor(root,{savePage:async p=>writes.push(p)},n.notebook,n.pages,{back:async()=>{},report:e=>assert.fail(e)});
  try {
    const stack=all(root).find(n=>n.className==='page-stack'),shell=all(root).find(n=>n.dataset.page),scroller=all(root).find(n=>n.className==='page-scroller');
    const finger=all(root).find(n=>n.getAttribute('type')==='checkbox');finger.checked=true;await finger.emit('change');
    const event={target:shell,pointerType:'touch',pointerId:1,clientX:24,clientY:144,pressure:.5,timeStamp:100};
    await stack.emit('pointerdown',event);await stack.emit('pointermove',{...event,clientX:36,timeStamp:110});
    if(start==='pinch') await scroller.emit('touchstart',{touches:[{clientX:36,clientY:144},{clientX:96,clientY:144}]});
    await stack.emit('pointercancel',event);
    if(start==='scroll') await scroller.emit('scroll');
    await scroller.emit('touchcancel',{touches:[]});
    await find(root,'再保存').click();assert.equal(n.pages[0].strokes.length,0);assert.equal(writes.length,0);
    assert.equal(find(root,'↶ 戻す').disabled,true);
  } finally {cleanup();}
}));

for(const tool of ['pen','highlighter'])for(const alpha of [1,.4])
test(`REV-013: ${tool}/画像alpha=${alpha}の通常線・連結線は描画中も画像/文字より下で、確定時と合成色が一致する`,()=>withDOM(async()=>{
  const flush=animationFrames(),root=new Node(),n=createNotebook(),page=n.pages[0];
  const oldImage=globalThis.Image;
  globalThis.Image=class {naturalWidth=1;naturalHeight=1;rgba=[0,1,0,alpha];name='near';async decode(){}};
  const blob=new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64')],{type:'image/png'});
  page.items=[
    {id:'near',type:'image',fileId:'near',x:18,y:98,w:10,h:4},
    {id:'text',type:'text',text:'字',fontSize:14,color:'#ff0000',x:29,y:98,w:20,h:19},
    {id:'far',type:'image',fileId:'far',x:400,y:500,w:20,h:20},
    {id:'far-text',type:'text',text:'遠',fontSize:14,color:'#000000',x:400,y:600,w:20,h:19}
  ];
  // Existing ink and a paper template must survive partial recomposition too.
  page.strokes=[{id:'old',tool:'highlighter',color:'#0000ff',size:8,points:[[15,100,.5],[40,100,.5]]}];
  const samples=[[22,100],[25,100],[27.5,100],[31,100],[34,100],[22,98.2],[22,101.8],[50,100],[410,510]];
  const originalContext=Node.prototype.getContext;
  Node.prototype.getContext=function(){
    if(!this.sampled)this.sampled=sampledCanvas(this,samples);
    return this.sampled.ctx;
  };
  let cleanup;
  try {
    cleanup=mountEditor(root,{getFile:async()=>({blob}),savePage:async()=>{}},n.notebook,n.pages,{back:async()=>{},report:e=>assert.fail(e)});
    await settle();
    if(tool==='highlighter')await find(root,'蛍光ペン').click();
    const stack=all(root).find(n=>n.className==='page-stack'),shell=all(root).find(n=>n.dataset.page);
    const [base,live]=shell.children.filter(n=>n.tagName==='canvas').map(c=>c.sampled);
    const composite=()=>base.pixels.map((p,i)=>over(p,live.pixels[i]));
    const event=(x,timeStamp,pointerId=1)=>({target:shell,pointerType:'pen',pointerId,clientX:x*1.2,clientY:144,pressure:.03,timeStamp});
    const reference=stroke=>{
      const target=sampledCanvas({width:page.width,height:page.height},samples);
      renderPage(target.ctx,{...page,strokes:[...page.strokes.filter(s=>s.id!==stroke.id),stroke]},[],{images:new Map([['near',{rgba:[0,1,0,alpha]}],['far',{rgba:[0,1,0,alpha]}]])});
      assert.deepEqual(composite(),target.pixels);
    };
    const ink={id:'preview',tool,color:'#263238',size:tool==='highlighter'?10:2,points:[[20,100,.03],[23,100,.03],[26,100,.03]]};
    await stack.emit('pointerdown',event(20,100));await stack.emit('pointermove',event(23,105));await stack.emit('pointermove',event(26,110));
    live.calls.length=0;flush();reference(ink);
    assert.ok(live.calls.findIndex(c=>c[0]==='image')>live.calls.findIndex(c=>c[0]==='ink'));
    assert.equal(live.calls.filter(c=>c[0]==='image').length,1);
    assert.deepEqual(live.calls.filter(c=>c[0]==='text').map(c=>c[1]),['字']);
    const ordinary=composite();await stack.emit('pointerup',{...event(26,115),pressure:0});assert.deepEqual(composite(),ordinary);
    const previous=page.strokes.at(-1);
    await stack.emit('pointerdown',event(29,155,2));flush();reference({...ink,points:[[29,100,.03]]});
    if(alpha===1)assert.deepEqual(composite()[0],[0,1,0,1]);
    await stack.emit('pointermove',event(32,160,2));flush();
    reference({...previous,points:[...previous.points,[29,100,.03],[32,100,.03]]});
    if(alpha===1)assert.deepEqual(composite()[0],[0,1,0,1]);
    const joined=composite();await stack.emit('pointerup',{...event(32,165,2),pressure:0});
    assert.deepEqual(composite(),joined);assert.equal(page.strokes.length,2);
    // A separate stroke far from every item needs no region or item repaint.
    base.calls.length=live.calls.length=0;
    await stack.emit('pointerdown',{...event(100,400,3),clientY:384});await stack.emit('pointermove',{...event(120,405,3),clientY:384});flush();
    assert.equal(base.calls.length,0);assert.deepEqual(live.calls.map(c=>c[0]),['clear','ink']);
    await stack.emit('pointerup',{...event(120,410,3),clientY:384});
    // Erasing still updates the base only and leaves items intact.
    const items=structuredClone(page.items);
    await find(root,'消しゴム').click();live.calls.length=0;
    await stack.emit('pointerdown',event(22,500,4));flush();
    assert.deepEqual(live.calls.map(c=>c[0]),['clear']);
    await stack.emit('pointerup',event(22,505,4));assert.deepEqual(page.items,items);
    assert.equal(page.strokes.length,1);
  } finally {cleanup?.();Node.prototype.getContext=originalContext;if(oldImage===undefined)delete globalThis.Image;else globalThis.Image=oldImage;}
}));
