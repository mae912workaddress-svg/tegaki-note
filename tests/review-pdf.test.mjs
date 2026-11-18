import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, StandardFonts, degrees } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import { OPS, Util, AnnotationMode } from '../vendor/pdfjs/pdf.mjs';
import { importFiles } from '../src/import/notebooks.js';
import { openPdf, PDF_ANNOTATION_MODE } from '../src/import/pdf.js';
import { exportPdf } from '../src/export/pdf.js';
import { excerpt } from '../src/model/search.js';

const closeTo = (actual, expected) => actual.forEach((v,i) => assert.ok(Math.abs(v-expected[i]) < 1e-5, `${actual} != ${expected}`));
async function exportImported(bytes) {
  const records = await importFiles([new File([bytes], 'source.pdf', {type:'application/pdf'})]);
  const output = await exportPdf(records.pages, {getFile:async id=>records.files.find(f=>f.id===id)});
  return {records,output};
}
async function displayText(bytes) {
  const pdf = await openPdf(new Blob([bytes]));
  try {
    const page = await pdf.getPage(1), operators = await page.getOperatorList({annotationMode:PDF_ANNOTATION_MODE});
    return operators.fnArray.flatMap((op,i)=>op===OPS.showText ? operators.argsArray[i][0].filter(g=>typeof g==='object').map(g=>g.unicode) : []).join('');
  } finally { await pdf.destroy(); }
}
test('REV-003: 入力済みフォームの表示をPDF.jsフォールバックへ渡し有効領域どおりPDFへ画像配置する', async()=>{
  assert.equal(PDF_ANNOTATION_MODE,AnnotationMode.ENABLE);
  const source=await PDFDocument.create(),page=source.addPage([300,500]);
  page.setCropBox(-100,20,350,430);page.setRotation(degrees(90));
  source.addPage([200,100]);
  const field=source.getForm().createTextField('visible');
  field.setText('VISIBLE FORM TEXT');field.addToPage(page,{x:20,y:50,width:200,height:40});
  source.getForm().updateFieldAppearances();
  const bytes=await source.save(),before=bytes.slice();
  assert.match(await displayText(bytes),/VISIBLE FORM TEXT/);
  const records=await importFiles([new File([bytes],'source.pdf',{type:'application/pdf'})]);
  let calls=0,released=0,encoded=0;
  const output=await exportPdf(records.pages,{
    getFile:async id=>records.files.find(f=>f.id===id),
    backgroundAssets:async (model,getFile,ratio)=>{
      calls++;assert.equal(model.background.pageIndex,0);assert.deepEqual(model.items,[]);
      assert.deepEqual([model.width,model.height],[430,250]);assert.equal(ratio,2);
      const input=await openPdf((await getFile(model.background.fileId)).blob);
      try{
        const rendered=await input.getPage(model.background.pageIndex+1),viewport=rendered.getViewport({scale:ratio});
        closeTo(rendered.view,[0,20,250,450]);closeTo([viewport.width,viewport.height],[860,500]);
        const ops=await rendered.getOperatorList({annotationMode:PDF_ANNOTATION_MODE});
        const text=ops.fnArray.flatMap((op,i)=>op===OPS.showText?ops.argsArray[i][0].filter(g=>typeof g==='object').map(g=>g.unicode):[]).join('');
        assert.match(text,/VISIBLE FORM TEXT/);
      }finally{await input.destroy();}
      // Substitute only canvas output; actual PDF.js display operators above
      // must contain the form text. Browser pixel rendering is a separate check.
      return {background:{toBlob(callback,mime){
        encoded++;assert.equal(mime,'image/png');
        callback(new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64')],{type:mime}));
      }},release(){released++;}};
    }
  });
  assert.equal(calls,1);assert.equal(encoded,1);assert.equal(released,1);
  const pdf=await openPdf(new Blob([output]));
  try {
    assert.equal(pdf.numPages,2);
    const p=await pdf.getPage(1);
    const viewport=p.getViewport({scale:1});closeTo([viewport.width,viewport.height],[430,250]);
    const other=(await pdf.getPage(2)).getViewport({scale:1});closeTo([other.width,other.height],[200,100]);
    const ops=await p.getOperatorList(),stack=[],placements=[];let matrix=[1,0,0,1,0,0];
    for(let i=0;i<ops.fnArray.length;i++){
      const op=ops.fnArray[i];
      if(op===OPS.save)stack.push(matrix.slice());
      else if(op===OPS.restore)matrix=stack.pop();
      else if(op===OPS.transform)matrix=Util.transform(matrix,ops.argsArray[i]);
      else if(op===OPS.paintImageXObject)placements.push(matrix.slice());
    }
    assert.equal(placements.length,1);closeTo(placements[0],[430,0,0,250,0,0]);
    assert.equal((await p.getAnnotations()).length,0); // Baked into the background.
  } finally { await pdf.destroy(); }
  assert.deepEqual(bytes,before);
});
test('REV-003: 通常注釈のAppearance・非原点BBox・Matrixと非表示フラグを保持する', async()=>{
  const pdf=await PDFDocument.create(),page=pdf.addPage([300,500]),font=await pdf.embedFont(StandardFonts.Helvetica);
  const appearance=pdf.context.flateStream('BT /F1 12 Tf 1 0 0 1 15 25 Tm (VISIBLE STAMP) Tj ET',{
    Type:'XObject',Subtype:'Form',BBox:[10,20,150,60],Matrix:[2,0,0,2,5,9],Resources:{Font:{F1:font.ref}}
  });
  const ref=pdf.context.register(appearance);
  const annotation=flags=>pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Stamp',Rect:[30,50,170,90],F:flags,AP:{N:ref}}));
  page.node.set(PDFName.of('Annots'),pdf.context.obj([annotation(0),annotation(2),annotation(32)]));
  const bytes=await pdf.save(),{output}=await exportImported(bytes);
  assert.equal(await displayText(bytes),'VISIBLE STAMP');
  assert.equal(await displayText(output),'VISIBLE STAMP');
  const exported=await openPdf(new Blob([output]));
  try { closeTo((await (await exported.getPage(1)).getTextContent()).items[0].transform,[12,0,0,12,35,55]); }
  finally { await exported.destroy(); }
});
for (const rotation of [0,90,180,270]) {
  test(`REV-004: CropBoxがMediaBoxを超えるPDFで回転${rotation}の位置と倍率を保持する`,async()=>{
    const pdf=await PDFDocument.create(),page=pdf.addPage([300,500]);
    page.setCropBox(-100,-100,400,600);page.setRotation(degrees(rotation));
    page.drawText('POSITION',{x:30,y:50,size:20});
    const bytes=await pdf.save(),{records,output}=await exportImported(bytes);
    const original=await openPdf(new Blob([bytes])),exported=await openPdf(new Blob([output]));
    try {
      const before=await original.getPage(1),after=await exported.getPage(1);
      const a=(await before.getTextContent()).items.find(i=>i.str==='POSITION');
      const b=(await after.getTextContent()).items.find(i=>i.str==='POSITION');
      const v1=before.getViewport({scale:1}),v2=after.getViewport({scale:1});
      assert.deepEqual([records.pages[0].width,records.pages[0].height],[v1.width,v1.height]);
      assert.deepEqual([v2.width,v2.height],[v1.width,v1.height]);
      closeTo(Util.transform(v1.transform,a.transform),Util.transform(v2.transform,b.transform));
      if(rotation===0)closeTo(b.transform,[20,0,0,20,30,50]);
    } finally { await original.destroy();await exported.destroy(); }
  });
}
test('REV-006: NFKCで照合し抜粋は大小文字・全半角・結合文字の原文を保持する',()=>{
  assert.ok(excerpt('Sample page 7 keyword7','ＫＥＹＷＯＲＤ７').includes('Sample page 7 keyword7'));
  assert.equal(excerpt('a'.repeat(50)+'TEST'+'b'.repeat(50),'test',3),'…aaaTESTbbb…');
  assert.equal(excerpt('前置き ｶﾞｲﾄﾞ と㍿とＡＢＣ 後ろ','ガイド',0),'…ｶﾞｲﾄﾞ…');
  assert.equal(excerpt('前㍿後','株式会社',0),'…㍿…');
  assert.equal(excerpt('前e\u0301後','é',0),'…e\u0301…');
});
