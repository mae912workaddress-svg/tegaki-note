import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { strokeOutline, appendStrokePoint } from '../src/render/strokes.js';
import { templateGeometry } from '../src/model/templates.js';
import { itemWidth, itemHeight, fitImage } from '../src/model/images.js';
import { createNotebook } from '../src/model/notebooks.js';
import { erasePartial } from '../src/model/geometry.js';
import { History } from '../src/model/history.js';
import { renderPage, drawStrokePreview } from '../src/render/page.js';
import { sampledCanvas, over } from './helpers/20261119-sampled-canvas.mjs';

// Execute the real renderer with only its imported outline function wrapped.
// No production counters, modified vendor files, network or timing-only oracle.
const source=await readFile(new URL('../src/render/page.js',import.meta.url),'utf8');
function instrumentedRenderer() {
  const calls=new Map();
  const outline=stroke=>{calls.set(stroke,(calls.get(stroke)||0)+1);return strokeOutline(stroke);};
  const renderer=Function('strokeOutline','templateGeometry','itemWidth','itemHeight','fitImage',
    source.replace(/^import .*;\r?\n/gm,'').replace(/export function /g,'function ')+
    '\nreturn {drawStroke, drawStrokePreview, renderPage};')(outline,templateGeometry,itemWidth,itemHeight,fitImage);
  return {...renderer,calls};
}
const ink=(id,points,size=2)=>({id,tool:'pen',color:'#123456',size,points});
function emptyContext(page) {
  const noop=()=>{};
  return new Proxy({canvas:{width:page.width,height:page.height},measureText:text=>({width:text.length*10})},
    {get:(target,key)=>target[key]??noop});
}

test('REV-014: 2000本×100点・PDF背景・150点の長い線でもウォーム後の既存輪郭計算は0回',t=>{
  const page=createNotebook().pages[0],renderer=instrumentedRenderer();
  page.background={type:'pdf',fileId:'pdf',pageIndex:0};
  page.strokes=Array.from({length:2000},(_,i)=>ink(`old-${i}`,
    Array.from({length:100},(_,j)=>[18+(i%20)*28+j*.15,18+Math.floor(i/20)*8,.5])));
  page.items=[{id:'image',type:'image',fileId:'image',x:18,y:18,w:30,h:30}];
  const stroke=ink('live',Array.from({length:150},(_,i)=>[20+550*i/149,20+780*i/149,.5]));
  const ctx=emptyContext(page),bitmap={},assets={background:bitmap,images:new Map([['image',{}]])};
  let backgrounds=0,vertices=0,clips=[];
  ctx.drawImage=image=>{if(image===bitmap)backgrounds++;};
  ctx.lineTo=()=>vertices++;
  ctx.rect=(...box)=>clips.push(box);
  renderer.renderPage(ctx,page,[],assets);
  assert.equal(renderer.calls.size,2000);
  for(let i=0;i<15;i++) renderer.drawStrokePreview(ctx,page,stroke,assets);
  renderer.calls.clear();backgrounds=vertices=0;clips=[];
  const times=[];
  for(let i=0;i<60;i++) {
    const start=performance.now();renderer.drawStrokePreview(ctx,page,stroke,assets);times.push(performance.now()-start);
  }
  assert.equal(page.strokes.reduce((sum,s)=>sum+(renderer.calls.get(s)||0),0),0);
  assert.equal(backgrounds,60,'reuse the supplied PDF bitmap once per frame');
  assert.equal(clips.length,60);
  assert.ok(clips.every(([x,y,w,h])=>x===18&&y===18&&w===30&&h===30),'clip only the image intersection');
  assert.ok(vertices/60<2000,'do not replay distant cached outlines');
  times.sort((a,b)=>a-b);const median=times[30],p95=times[57];
  t.diagnostic(`60 frames: median=${median.toFixed(3)}ms, p95=${p95.toFixed(3)}ms, existing strokeOutline=0, vertices/frame=${vertices/60}`);
  assert.ok(median<4,`supplementary JS median ${median.toFixed(3)}ms < 4ms`);
  // Moving input still computes only its own new outline, never static ink.
  for(let i=0;i<10;i++) {stroke.points.at(-1)[0]+=.01;renderer.drawStrokePreview(ctx,page,stroke,assets);}
  assert.equal(renderer.calls.get(stroke),10);
  assert.equal(page.strokes.reduce((sum,s)=>sum+(renderer.calls.get(s)||0),0),0);
});

test('REV-014: 部分消去・Undo/Redo・連結・同一IDのページ切替で古い輪郭を再利用しない',()=>{
  const renderer=instrumentedRenderer(),page=createNotebook().pages[0],ctx=emptyContext(page),history=new History();
  let path=[];ctx.moveTo=(...point)=>path.push(point);ctx.lineTo=(...point)=>path.push(point);
  const check=stroke=>{path=[];renderer.drawStroke(ctx,stroke);assert.deepEqual(path,strokeOutline(stroke));};
  const original=ink('same-id',[[20,100,.03],[26,100,.03],[32,100,.03],[60,100,.03]]);
  page.strokes=[original];check(original);check(original);assert.equal(renderer.calls.get(original),1);
  const before={strokes:page.strokes};
  page.strokes=erasePartial(original,[40,100],3);
  assert.equal(page.strokes.length,2);history.commit(before,{strokes:page.strokes});page.strokes.forEach(check);
  Object.assign(page,history.undo({strokes:page.strokes}));page.strokes.forEach(check);
  assert.deepEqual(page.strokes,[original]);
  Object.assign(page,history.redo({strokes:page.strokes}));page.strokes.forEach(check);assert.equal(page.strokes.length,2);
  const joined=structuredClone(original);check(joined);
  appendStrokePoint(joined.points,[63,100,.03]);appendStrokePoint(joined.points,[66,100,.03]);check(joined);
  assert.equal(renderer.calls.get(joined),2);
  // Same object/array/length changes must also invalidate, including interior pressure.
  joined.points[1][1]=104;check(joined);joined.points[1][2]=.9;check(joined);
  joined.size=12;check(joined);joined.tool='highlighter';check(joined);
  joined.points=joined.points.map(([x,y,p])=>[x,y+5,p]);check(joined);
  assert.equal(renderer.calls.get(joined),7);
  joined.color='#ff0000';check(joined);assert.equal(renderer.calls.get(joined),7);assert.equal(ctx.fillStyle,'#ff0000');
  const otherPageStroke=ink(original.id,[[200,300,.7],[250,300,.7]]);
  check(otherPageStroke);check(original);assert.equal(renderer.calls.get(original),1);
});

test('REV-014: キャッシュ済み外接矩形も座標変更・消去・復元で更新し、再合成対象を間引く',()=>{
  const renderer=instrumentedRenderer(),page=createNotebook().pages[0],ctx=emptyContext(page);
  page.items=[{id:'image',type:'image',fileId:'image',x:18,y:18,w:30,h:30}];
  const old=ink('old',[[400,400,.5],[410,410,.5]]),live=ink('live',[[20,20,.5],[570,800,.5]]);
  page.strokes=[old];renderer.drawStrokePreview(ctx,page,live);assert.equal(renderer.calls.has(old),false);
  old.points[0]=[20,20,.5];old.points[1]=[30,30,.5];
  renderer.drawStrokePreview(ctx,page,live);assert.equal(renderer.calls.get(old),1);
  old.points[0]=[400,400,.5];old.points[1]=[410,410,.5];
  renderer.drawStrokePreview(ctx,page,live);assert.equal(renderer.calls.get(old),1);
  page.strokes=[];renderer.drawStrokePreview(ctx,page,live);assert.equal(renderer.calls.get(old),1);
  old.points=[[20,20,.5],[35,35,.5]];page.strokes=[old];
  renderer.drawStrokePreview(ctx,page,live);assert.equal(renderer.calls.get(old),2);
});

for(const tool of ['pen','highlighter'])test(`REV-014: ${tool}の離れた/重なる半透明items領域を一度だけ合成し、背景・確定色と一致する`,()=>{
  const page=createNotebook().pages[0];page.background={type:'pdf',fileId:'pdf'};
  page.items=[
    {id:'a',type:'image',fileId:'a',x:18,y:18,w:30,h:30},
    {id:'b',type:'image',fileId:'b',x:35,y:35,w:25,h:25},
    {id:'c',type:'image',fileId:'a',x:400,y:400,w:30,h:30}];
  page.strokes=[{...ink('old',[[10,10,.5],[500,500,.5]],8),tool:'highlighter'}];
  const points=[[21,21],[40,40],[50,50],[100,100],[399,399],[410,410],[500,500],[40,42]];
  const assets={background:{rgba:[.8,.8,.8,1]},images:new Map([['a',{rgba:[0,1,0,.4]}],['b',{rgba:[1,0,0,.3]}]])};
  const live={...ink('live',[[20,20,.1],[200,200,.3],[550,550,.1]],8),tool};
  const canvas={width:page.width,height:page.height},base=sampledCanvas(canvas,points),preview=sampledCanvas(canvas,points),expected=sampledCanvas(canvas,points);
  renderPage(base.ctx,page,[],assets);drawStrokePreview(preview.ctx,page,live,assets);
  renderPage(expected.ctx,{...page,strokes:[...page.strokes,live]},[],assets);
  assert.deepEqual(base.pixels.map((pixel,i)=>over(pixel,preview.pixels[i])),expected.pixels);
  assert.equal(preview.calls.filter(c=>c[0]==='clip').length,1,'one union clip, including overlapping rectangles');
});
