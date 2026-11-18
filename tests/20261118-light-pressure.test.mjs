import test from 'node:test';
import assert from 'node:assert/strict';
import { strokeOutline, strokePoints, strokeOptions, appendStrokePoint, canJoinStrokeSegments } from '../src/render/strokes.js';
import { drawStroke, renderPage } from '../src/render/page.js';
import { createNotebook } from '../src/model/notebooks.js';
import { exportPdf } from '../src/export/pdf.js';
import { PDFDocument, decodePDFRawStream } from '../vendor/pdf-lib/pdf-lib.esm.min.js';

const ink = (size=2, pressure) => ({id:'light',tool:'pen',color:'#123456',size,
  points:Array.from({length:401},(_,i)=>[20+i*.5,100,pressure ?? [0,.03,.06,.12,.09][i%5]])});

test('REV-001: 純粋な連結判定は長さ・終端速度・停止・80ms・3pt・方向・次入力の動きをすべて確認する',()=>{
  const previous={points:[[20,100],[23,100],[26,100]],samples:[[20,100,100],[23,100,105],[26,100,110],[26,100,115]],endTime:115};
  const next={points:[[27,100],[30,100],[33,100]],startTime:155};
  const saved=structuredClone({previous,next});
  assert.equal(canJoinStrokeSegments(previous,next),true);
  assert.equal(canJoinStrokeSegments(previous,{...next,startTime:195}),true);
  assert.equal(canJoinStrokeSegments(previous,{...next,points:[[29,100],[32,100]]}),true);
  assert.equal(canJoinStrokeSegments(previous,{...next,points:[[26,100],[29,100]]}),true);
  for(const [name,p,n] of [
    ['previous dot',{...previous,points:[[26,100]]},next],
    ['previous short flick',{...previous,points:[[24,100],[26,100]]},next],
    ['stationary tail',{...previous,samples:[[26,100,100],[26,100,105],[26,100,110],[26,100,115]]},next],
    ['stopped before up',{...previous,endTime:140},next],
    ['slow tail',{...previous,samples:[[25.5,100,100],[25.7,100,105],[26,100,110],[26,100,115]]},next],
    ['long gap',previous,{...next,startTime:196}],
    ['negative gap',previous,{...next,startTime:114}],
    ['far',previous,{...next,points:[[29.01,100],[33,100]]}],
    ['sideways',previous,{...next,points:[[26,102],[30,102]]}],
    ['backwards',previous,{...next,points:[[25,100],[30,100]]}],
    ['next dot',previous,{...next,points:[[27,100]]}],
    ['next short flick',previous,{...next,points:[[27,100],[29,100]]}],
    ['next turns back',previous,{...next,points:[[27,100],[23,100]]}],
    ['missing time',{...previous,samples:[[20,100,NaN],[26,100,110]]},next],
    ['nonmonotonic time',{...previous,samples:[[20,100,110],[26,100,100]]},next]
  ]) assert.equal(canJoinStrokeSegments(p,n),false,name);
  assert.deepEqual({previous,next},saved);
});
test('REV-012: 連結判定の長さ3pt・速度0.08pt/ms・停止16msの境界',()=>{
  const previous={points:[[0,100],[4,100]],samples:[[0,100,0],[4,100,40]],endTime:50};
  const next={points:[[5,100],[9,100]],startTime:90};
  for(const [length,expected] of [[2.999,false],[3,true],[3.001,true]]) {
    const p={...previous,points:[[4-length,100],[4,100]]};
    assert.equal(canJoinStrokeSegments(p,next),expected,`previous length=${length}`);
    assert.equal(canJoinStrokeSegments(previous,{...next,points:[[5,100],[5+length,100]]}),expected,`next length=${length}`);
  }
  for(const [speed,expected] of [[.07999,false],[.08,true],[.08001,true]]) {
    const distance=50*speed;
    assert.equal(canJoinStrokeSegments({...previous,samples:[[4-distance,100,0],[4,100,40]]},next),expected,`speed=${speed}`);
  }
  for(const [pause,expected] of [[15.999,true],[16,true],[16.001,false]]) {
    const p={...previous,points:[[0,100],[6,100]],samples:[[0,100,0],[6,100,40]],endTime:40+pause};
    assert.equal(canJoinStrokeSegments(p,{...next,points:[[7,100],[11,100]]}),expected,`pause=${pause}`);
  }
});

function widthAt(outline,x) {
  const ys=[];
  for(let i=0;i<outline.length;i++) {
    const a=outline[i],b=outline[(i+1)%outline.length];
    if((a[0]<=x&&x<b[0])||(b[0]<=x&&x<a[0])) ys.push(a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]));
  }
  assert.ok(ys.length>=2,`輪郭の欠落 x=${x}`);
  return Math.max(...ys)-Math.min(...ys);
}

test('USR-004: 0.03〜0.12と途中の0を含む長い線は始端から終端まで1.25pt以上を保つ',()=>{
  for(const size of [1,2,4,7,12]) {
    const stroke=ink(size),saved=structuredClone(stroke),outline=strokeOutline(stroke);
    for(let x=20.001;x<220;x+=.1) assert.ok(widthAt(outline,x)>=1.25-1e-6,`size=${size} x=${x}`);
    const corrected=strokePoints(stroke);
    for(let i=5;i<corrected.length;i+=5) assert.equal(corrected[i][2],corrected[i-1][2]);
    assert.deepEqual(stroke,saved); // Existing stored pressure/coordinates stay untouched.
  }
});

test('USR-004: 強い筆圧の線は軽い筆圧より太く、短い線はtaperで消えない',()=>{
  for(const size of [1,2,4,7,12]) {
    const light=strokeOutline(ink(size,.1)),heavy=strokeOutline(ink(size,.9));
    assert.ok(widthAt(heavy,100)>widthAt(light,100)*1.3);
    for(const length of [.05,.5,1,2]) {
      const stroke={...ink(size),points:[[20,100,.03],[20+length,100,0]]};
      assert.equal(strokeOptions(stroke).end.taper,0);
      assert.ok(widthAt(strokeOutline(stroke),20+length/2)>=1.25);
    }
    assert.ok(strokeOptions(ink(size)).end.taper<=200);
  }
});

test('USR-004: 低速の0.03pt刻みを保持し、重複と巨大な外れ値だけを除く',()=>{
  const points=[[20,100,.03]];
  for(let i=1;i<=200;i++) appendStrokePoint(points,[20+i*.03,100,i%4?.06:0]);
  assert.equal(points.length,201);
  appendStrokePoint(points,[26,100,.9]);appendStrokePoint(points,[1000,100,.1]);
  assert.equal(points.length,201);
  const outline=strokeOutline({...ink(),points});
  for(let x=20.01;x<26;x+=.05) assert.ok(widthAt(outline,x)>=1.25);
});

test('USR-004: 低筆圧の描画中・確定/JPG用描画・実PDFの輪郭座標が一致する',async()=>{
  const page=createNotebook().pages[0];page.strokes=[ink()];
  const saved=structuredClone(page),paths=[];
  const ctx=new Proxy({moveTo:(...p)=>paths.push(p),lineTo:(...p)=>paths.push(p)}, {get:(target,key)=>target[key]??(()=>{})});
  drawStroke(ctx,page.strokes[0]);const live=structuredClone(paths);paths.length=0;
  renderPage(ctx,page);assert.deepEqual(paths,live);
  assert.deepEqual(live,strokeOutline(page.strokes[0]));
  const bytes=await exportPdf([page],{getFile:async()=>assert.fail('白紙は外部ファイル不要')});
  const pdf=await PDFDocument.load(bytes),streams=pdf.getPage(0).node.Contents();
  const content=Array.from({length:streams.size()},(_,i)=>new TextDecoder().decode(decodePDFRawStream(pdf.context.lookup(streams.get(i))).decode())).join('\n');
  // The path retains page coordinates; its graphics state supplies the y flip.
  const inkContent=content.split('Q\n').find(part=>part.includes('1 0 0 -1 0 0 cm'));
  assert.ok(inkContent?.includes(`1 0 0 1 0 ${page.height} cm`));
  const exported=[...inkContent.matchAll(/^([-\d.e+]+) ([-\d.e+]+) [ml]$/gm)].map(m=>[Number(m[1]),Number(m[2])]);
  assert.deepEqual(exported,live);
  assert.deepEqual(page,saved);
});

test('REV-013: 実PDFでもペン/蛍光ペンの共通輪郭の後に画像・テキストを配置する',async()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
  for(const tool of ['pen','highlighter']) {
    const page=createNotebook().pages[0];
    page.strokes=[{...ink(2,.03),tool,points:[[20,100,.03],[23,100,.03],[26,100,.03],[29,100,.03],[32,100,.03]]}];
    page.items=[{id:'image',type:'image',fileId:'image',x:18,y:98,w:10,h:4},
      {id:'text',type:'text',text:'字',fontSize:14,color:'#ff0000',x:29,y:98,w:20,h:19}];
    let textCount=0;
    const bytes=await exportPdf([page],{getFile:async()=>({mime:'image/png',blob:new Blob([png])}),
      rasterizeText:async item=>{assert.equal(item.id,'text');textCount++;return {bytes:png,height:19};}});
    const pdf=await PDFDocument.load(bytes),streams=pdf.getPage(0).node.Contents();
    const content=Array.from({length:streams.size()},(_,i)=>new TextDecoder().decode(decodePDFRawStream(pdf.context.lookup(streams.get(i))).decode())).join('\n');
    const inkContent=content.split('Q\n').find(part=>part.includes('1 0 0 -1 0 0 cm'));
    const outline=[...inkContent.matchAll(/^([-\d.e+]+) ([-\d.e+]+) [ml]$/gm)].map(m=>[Number(m[1]),Number(m[2])]);
    assert.deepEqual(outline,strokeOutline(page.strokes[0]));
    const items=[...content.matchAll(/^\/Image[^\n]+ Do$/gm)];
    assert.equal(items.length,2);assert.equal(textCount,1);
    assert.ok(items.every(match=>match.index>content.indexOf(inkContent)+inkContent.length));
  }
});
