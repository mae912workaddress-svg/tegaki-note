import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { streamPdf, encryptedPdf } from './helpers/20261118-pdf-fixtures.mjs';
import { importFiles } from '../src/import/notebooks.js';
import { openPdf, PDF_ANNOTATION_MODE } from '../src/import/pdf.js';
import { validatePdfContents } from '../src/model/validation.js';
import { createBackup, prepareBackupRestore } from '../src/storage/backup.js';
import { exportPdf } from '../src/export/pdf.js';
import { PDFDocument } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import { OPS } from '../vendor/pdfjs/pdf.mjs';
import { configureCanvas } from '../src/render/page.js';
import { pointerPressure, appendStrokePoint, strokePoints, strokeOutline } from '../src/render/strokes.js';

for(const mode of ['owner-password','missing-adler','raw','trailing','object-xref-streams']) {
  test(`USR-001: 実PDF.jsで${mode}を取込み・書き出し・新版/旧版復元できる`,async()=>{
    const bytes=mode==='owner-password'?encryptedPdf():await streamPdf(mode);
    if(mode==='object-xref-streams') {
      assert.match(Buffer.from(bytes).toString('latin1'),/\/Type \/ObjStm/);
      assert.match(Buffer.from(bytes).toString('latin1'),/\/Type \/XRef/);
    }
    const records=await importFiles([new File([bytes],`${mode}.pdf`,{type:'application/pdf'})]);
    assert.equal(records.pages.length,1);
    records.pages[0].strokes.push({id:'ink',tool:'pen',size:2,color:'#123456',points:[[50,50,.4],[70,60,.5],[90,75,.5]]});
    let rasterCalls=0,releases=0;
    const output=await exportPdf(records.pages,{getFile:async id=>records.files.find(f=>f.id===id),backgroundAssets:async(page,getFile,ratio)=>{
      rasterCalls++;assert.equal(ratio,2);
      const doc=await openPdf((await getFile(page.background.fileId)).blob);
      try {
        const source=await doc.getPage(1),ops=await source.getOperatorList({annotationMode:PDF_ANNOTATION_MODE});
        if(mode==='owner-password') assert.ok(ops.fnArray.includes(OPS.constructPath));
      } finally {await doc.destroy();}
      // Test the real PDF.js operator evaluation and export integration. Canvas
      // pixels themselves require a browser; substitute only PNG encoding here.
      return {background:{toBlob(cb){cb(new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64')],{type:'image/png'}));}},release(){releases++;}};
    }});
    if(mode==='owner-password'||mode==='raw') assert.equal(rasterCalls,1);
    assert.equal(releases,rasterCalls);
    const exported=await openPdf(new Blob([output]));
    try {
      assert.equal(exported.numPages,1);
      const page=await exported.getPage(1),ops=await page.getOperatorList();
      assert.deepEqual([page.getViewport({scale:1}).width,page.getViewport({scale:1}).height],[300,500]);
      assert.ok(ops.fnArray.includes(OPS.constructPath)); // Added ink survives.
      if(rasterCalls) assert.ok(ops.fnArray.includes(OPS.paintImageXObject));
    } finally {await exported.destroy();}
    const backup=await createBackup(records);
    assert.equal(backup.version,2);assert.equal(backup.files[0].byteLength,bytes.length);
    assert.equal(backup.files[0].sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.equal((await prepareBackupRestore(backup)).pages.length,1);
    const legacy=structuredClone(backup);legacy.version=1;delete legacy.files[0].sha256;delete legacy.files[0].byteLength;
    assert.equal((await prepareBackupRestore(legacy)).pages.length,1);
  });
}

test('USR-001: パスワードが必要なPDFとPDF.jsで開けない破損PDFは拒否する',async()=>{
  await assert.rejects(importFiles([new File([encryptedPdf('secret')],'password.pdf')]),/^Error: パスワード付きPDFは読み込めません$/);
  await assert.rejects(importFiles([new File(['%PDF-1.7\nnot a PDF'],'broken.pdf')]),/PDFを開けません/);
});

test('USR-001: 全ページを順番に演算子検証・解放し、後続ページの失敗も破棄する',async()=>{
  for(const fail of [0,2]) {
    const events=[];
    const open=async()=>({numPages:3,getPage:async n=>{
      events.push(`page${n}`);return {getViewport:()=>({width:300,height:500}),
        getOperatorList:async options=>{assert.equal(options.annotationMode,PDF_ANNOTATION_MODE);events.push(`ops${n}`);if(n===fail)throw new Error('bad operators');},
        getTextContent:async()=>({items:[]}),cleanup:()=>events.push(`clean${n}`)};
    },destroy:async()=>events.push('destroy')});
    for(const run of [()=>importFiles([new File(['%PDF-test'],'test.pdf')],null,{openPdf:open}),()=>validatePdfContents(new Blob(),{openPdf:open})]) {
      events.length=0;
      if(fail) await assert.rejects(run(),/bad operators/);else await run();
      assert.deepEqual(events,[...Array.from({length:fail||3},(_,i)=>[`page${i+1}`,`ops${i+1}`,`clean${i+1}`]).flat(),'destroy']);
    }
  }
});

test('USR-001: 埋込みの遅延デコード失敗でも最後のsaveが成功し背景を解放する',async t=>{
  const records=await importFiles([new File([await streamPdf('normal')],'test.pdf')]);
  t.mock.method(PDFDocument.prototype,'embedPage',async()=>({embed:async()=>{throw new Error('cannot embed');}}));
  let released=0;
  const bytes=await exportPdf(records.pages,{getFile:async()=>records.files[0],backgroundAssets:async()=>({background:{toBlob(cb){cb(new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64')]));}},release(){released++;}})});
  assert.equal((await PDFDocument.load(bytes)).getPageCount(),1);assert.equal(released,1);
});

test('USR-002: canvasの内部ピクセルは表示サイズ×DPRで400万画素/4096px上限を守る',()=>{
  for(const scale of [.5,1,1.2,2,4])for(const dpr of [1,2,3]) {
    let transform;const canvas={style:{},getContext:()=>({setTransform:(...args)=>transform=args})};
    const page={width:595.28,height:841.89};configureCanvas(canvas,page,scale,dpr);
    const ratio=Math.min(scale*dpr,Math.sqrt(4000000/(page.width*page.height)),4096/page.height);
    assert.equal(canvas.width,Math.floor(page.width*ratio));assert.equal(canvas.height,Math.floor(page.height*ratio));
    assert.equal(canvas.style.width,`${page.width*scale}px`);assert.equal(canvas.style.height,`${page.height*scale}px`);
    assert.deepEqual(transform,[canvas.width/page.width,0,0,canvas.height/page.height,0,0]);
    assert.ok(canvas.width*canvas.height<=4000000);
  }
});

test('USR-003: Pencilの離筆0を0.5にせず既存線の終端急変を補正し、マウス0は0.5にする',()=>{
  assert.equal(pointerPressure({pointerType:'mouse',pressure:0}),.5);
  assert.equal(pointerPressure({pointerType:'pen',pressure:0}),0);
  assert.equal(pointerPressure({pointerType:'pen'}),.5);
  const points=[[0,0,.4],[10,0,.5],[20,0,.5],[30,0,.5]];
  appendStrokePoint(points,[40,0,0],{terminal:true});assert.equal(points.at(-1)[2],.5);
  for(const ending of [0,1,.5]) {
    const stroke={tool:'pen',size:4,points:[[0,0,.4],[10,0,.5],[20,0,.5],[30,0,ending===.5?.1:.5],[40,0,ending]]},before=structuredClone(stroke);
    const corrected=strokePoints(stroke);assert.ok(corrected.at(-1)[2]<=corrected.at(-2)[2]);
    const outline=strokeOutline(stroke),tail=outline.filter(([x])=>x>38),middle=outline.filter(([x])=>x>15&&x<25);
    assert.ok(tail.length&&middle.length);
    assert.ok(Math.max(...tail.map(p=>Math.abs(p[1])))<=Math.max(...middle.map(p=>Math.abs(p[1]))));
    assert.deepEqual(stroke,before);
  }
});

test('USR-002: 重複・近接点と極端な座標外れ値を間引く',()=>{
  const points=[[0,0,.5],[1,0,.5]];
  appendStrokePoint(points,[1.01,0,.9]);appendStrokePoint(points,[800,0,.5]);assert.equal(points.length,2);
  appendStrokePoint(points,[2,0,.6]);assert.equal(points.length,3);
});
