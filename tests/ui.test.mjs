import test from 'node:test';
import assert from 'node:assert/strict';
import { mountEditor } from '../src/ui/editor.js';
import { mountLibrary,newNotebookDialog } from '../src/ui/library.js';
import { createNotebook } from '../src/model/notebooks.js';

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
