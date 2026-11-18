import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument,degrees,PDFName,PDFArray,decodePDFRawStream } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import { jpegInfo,pngInfo,fitImage,imagePageLayout } from '../src/model/images.js';
import { createNotebook,createPage,duplicatePage,reorderPages } from '../src/model/notebooks.js';
import { History } from '../src/model/history.js';
import { pageContent,moveItems,selectItems,moveContent } from '../src/model/items.js';
import { createBackup,validateBackup } from '../src/storage/backup.js';
import { searchNotes,normalizeSearch,excerpt } from '../src/model/search.js';
import { exportPdf } from '../src/export/pdf.js';
import { exportJpg,rasterSize,shareOrDownload } from '../src/export/files.js';
import { importFiles } from '../src/import/notebooks.js';
import { validPage } from '../src/model/validation.js';
import { openPdf } from '../src/import/pdf.js';
import { loadImage } from '../src/import/images.js';

function jpeg(width=400,height=200,orientation=1,little=true) {
  const exif=new Uint8Array(32),v=new DataView(exif.buffer);exif.set([69,120,105,102,0,0]);v.setUint16(6,little?0x4949:0x4d4d);v.setUint16(8,42,little);v.setUint32(10,8,little);v.setUint16(14,1,little);v.setUint16(16,0x112,little);v.setUint16(18,3,little);v.setUint32(20,1,little);v.setUint16(24,orientation,little);
  return new Uint8Array([255,216,255,225,0,34,...exif,255,192,0,17,8,height>>8,height&255,width>>8,width&255,3,1,17,0,2,17,0,3,17,0,255,217]);
}
function fixture() {
  const n=createNotebook({name:'ＡＢＣ 会議'});return {folders:[],notebooks:[n.notebook],pages:n.pages,files:[]};
}
const fileRecord=(id,bytes,mime='image/jpeg')=>({id,name:id,mime,blob:new Blob([bytes],{type:mime})});

test('JPEG寸法とEXIF 1〜8を両バイト順で読む',()=>{
  for(const little of [true,false])for(let o=1;o<=8;o++){
    const info=jpegInfo(jpeg(400,200,o,little));assert.deepEqual(info,{width:400,height:200,orientation:o,displayWidth:o>=5?200:400,displayHeight:o>=5?400:200});
  }
});
test('EXIF後のXMPが回転を上書きせず、無効値の後の有効EXIFを採用する',()=>{
  const image=jpeg(400,200,6),xmp=[255,225,0,6,88,77,80,0];
  assert.equal(jpegInfo(new Uint8Array([...image.slice(0,38),...xmp,...image.slice(38)])).orientation,6);
  const invalid=jpeg(400,200,0);assert.equal(jpegInfo(new Uint8Array([...invalid.slice(0,38),...image.slice(2)])).orientation,6);
});
test('巨大・途切れ・壊れたJPEGをデコード前に拒否する',()=>{
  assert.throws(()=>jpegInfo(jpeg(10000,6000)),/5000万/);
  assert.throws(()=>jpegInfo(jpeg().slice(0,20)));assert.throws(()=>jpegInfo(new Uint8Array([1,2,3])));
  const corrupt=jpeg();corrupt[16]=255;corrupt[17]=255;assert.throws(()=>jpegInfo(corrupt));
});
test('復元ファイルの描画も巨大JPEGをImage生成前に拒否する',async()=>{
  await assert.rejects(loadImage(new Blob([jpeg(10000,6000)],{type:'image/jpeg'})),/5000万/);
});
test('PNG寸法の上限検査とA4配置の向き・余白・縦横比',()=>{
  const png=new Uint8Array(33);png.set([137,80,78,71,13,10,26,10]);png.set([73,72,68,82],12);const v=new DataView(png.buffer);v.setUint32(16,200);v.setUint32(20,400);
  assert.deepEqual(pngInfo(png),{width:200,height:400});v.setUint32(16,100000);assert.throws(()=>pngInfo(png));
  const p=imagePageLayout(400,200);assert.ok(p.width>p.height);assert.equal(p.placement.w/p.placement.h,2);assert.ok(p.placement.y>0);
  const q=imagePageLayout(200,400);assert.ok(q.width<q.height);assert.deepEqual(fitImage(200,100,300,300),{x:0,y:75,w:300,h:150});
});
test('PDF書き出しは回転PDF・JPG・白紙混在のページ数と寸法を保持する',async()=>{
  const source=await PDFDocument.create(),original=source.addPage([300,500]);original.setRotation(degrees(90));original.drawText('Vector original',{x:20,y:30});
  const raw=fixture(),n=raw.notebooks[0],a=raw.pages[0];a.width=500;a.height=300;a.background={type:'pdf',fileId:'pdf',pageIndex:0};
  const b=createPage(n.id,{orientation:'landscape'});b.background={type:'image',fileId:'jpg',...fitImage(400,200,b.width,b.height)};
  const c=createPage(n.id,{template:'grid'});c.strokes=[{id:'s',tool:'highlighter',color:'#123456',size:10,points:[[20,30,.5],[80,90,.5]]}];
  const files=new Map([['pdf',fileRecord('pdf',await source.save(),'application/pdf')],['jpg',fileRecord('jpg',jpeg())]]);
  const bytes=await exportPdf([a,b,c],{getFile:async id=>files.get(id)}),output=await PDFDocument.load(bytes);
  assert.equal(output.getPageCount(),3);assert.deepEqual(output.getPages().map(p=>p.getSize()),[a,b,c].map(({width,height})=>({width,height})));
  const streams=output.getPage(0).node.Contents();assert.ok(streams instanceof PDFArray);
  const content=Array.from({length:streams.size()},(_,i)=>new TextDecoder().decode(decodePDFRawStream(output.context.lookup(streams.get(i))).decode())).join('\n');
  assert.match(content,/Do/);assert.ok(output.getPage(0).node.Resources().lookup(PDFName.of('XObject')).keys().length>0);
});
test('日本語テキストのラスタライズを注入し画像とともにPDFへ埋め込む',async()=>{
  const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=','base64'));
  const p=fixture().pages[0];p.items=[{id:'t',type:'text',text:'日本語',x:10,y:20,w:100,fontSize:22,color:'#123456'},{id:'i',type:'image',fileId:'img',x:40,y:60,w:100,h:50}];
  let calls=0;const bytes=await exportPdf([p],{getFile:async()=>fileRecord('img',jpeg()),rasterizeText:async item=>{calls++;assert.equal(item.text,'日本語');return {bytes:png,height:30};}});
  assert.equal(calls,1);assert.equal((await PDFDocument.load(bytes)).getPageCount(),1);
});
test('JPGはページ数分のファイルと元ページ番号を出しキャンバスを400万画素以下に制限する',async()=>{
  const raw=fixture(),n=raw.notebooks[0];const p=createPage(n.id);raw.pages.push(p);n.pageIds.push(p.id);
  const render=async()=>new Blob(['jpg'],{type:'image/jpeg'}),files=await exportJpg(n,raw.pages,render);
  assert.deepEqual(files.map(f=>f.name),['ＡＢＣ 会議_p01.jpg','ＡＢＣ 会議_p02.jpg']);
  assert.deepEqual((await exportJpg(n,raw.pages,render,'current',p.id)).map(f=>f.name),['ＡＢＣ 会議_p02.jpg']);
  const a4=rasterSize(raw.pages[0]);assert.ok(Math.abs(a4.width-1654)<=1);assert.ok(Math.abs(a4.height-2339)<=1);
  for(const page of [{width:10000,height:10000},{width:1,height:10000},raw.pages[0]]){const size=rasterSize(page);assert.ok(size.width*size.height<=4000000);assert.ok(Math.max(size.width,size.height)<=4096);}
});
test('共有呼出しはawaitを挟まずユーザー操作の同期区間で行う',async()=>{
  const files=[new File(['x'],'a.pdf',{type:'application/pdf'})];let called=false;
  const promise=shareOrDownload(files,()=>{}, {canShare:()=>true,share:arg=>{called=true;assert.equal(arg.files,files);return Promise.resolve();}},{});
  assert.equal(called,true);await promise;
});
test('バックアップ作成・検証の往復で全ストアとファイル本体が一致する',async()=>{
  const raw=fixture();raw.files.push(fileRecord('jpg',jpeg()));raw.pages[0].items.push({id:'image',type:'image',fileId:'jpg',x:1,y:2,w:100,h:50});
  const now=new Date('2026-11-18T00:00:00Z'),backup=await createBackup(raw,now),restored=validateBackup(JSON.stringify(backup));
  for(const s of ['folders','notebooks','pages'])assert.deepEqual(restored[s],raw[s]);
  assert.deepEqual(await restored.files[0].blob.arrayBuffer(),await raw.files[0].blob.arrayBuffer());assert.equal(restored.files[0].mime,'image/jpeg');
});
test('バックアップは必須ストア欠落・未知版・参照切れ・件数不一致・不正base64を拒否する',async()=>{
  const raw=fixture();raw.files.push(fileRecord('jpg',jpeg()));
  raw.pages[0].items.push({id:'image',type:'image',fileId:'jpg',x:1,y:2,w:100,h:50});
  const backup=await createBackup(raw);
  const changes=[b=>delete b.folders,b=>delete b.notebooks,b=>delete b.pages,b=>delete b.files,b=>b.version=2,b=>b.notebooks[0].folderId='missing',b=>b.counts.pages++,b=>b.files[0].base64='!!!!',b=>b.files[0].base64='Zh==',b=>b.pages[0].width=Infinity,b=>b.pages[0].background={type:'image',fileId:'missing'},b=>b.notebooks[0].pageIds.push('missing')];
  for(const change of changes){const b=structuredClone(backup);change(b);assert.throws(()=>validateBackup(b));}
  assert.deepEqual(validateBackup(await createBackup({folders:[],notebooks:[],pages:[],files:[]})),{folders:[],notebooks:[],pages:[],files:[]});
});
test('検索がNFKC・小文字化に対応しPDF文字・テキストとページ番号を返す',()=>{
  assert.equal(normalizeSearch('ＡＢＣ ｶﾞ'),'abc ガ');const raw=fixture(),n=raw.notebooks[0];
  raw.pages[0].text='会議の資料 ＰＤＦ を検索';const page=createPage(n.id);page.items=[{type:'text',text:'ｶﾞｲﾄﾞの文字'}];raw.pages.push(page);n.pageIds.push(page.id);
  assert.equal(searchNotes(raw.notebooks,raw.pages,'abc')[0].name,n.name);
  assert.equal(searchNotes(raw.notebooks,raw.pages,'pdf')[0].pageNumber,1);assert.equal(searchNotes(raw.notebooks,raw.pages,'ガイド')[0].pageNumber,2);
  assert.equal(excerpt('a'.repeat(50)+'TEST'+'b'.repeat(50),'test',3),'…aaaTESTbbb…');
});
test('ページ複製はitemsを深いコピーにし並べ替え後も参照が整合する',()=>{
  const raw=fixture(),page=raw.pages[0];page.items=[{id:'t',type:'text',text:'文字',x:1,y:2,w:100,fontSize:22,color:'#123456'}];
  const copy=duplicatePage(raw.notebooks[0],raw.pages,page.id);assert.notEqual(copy.page.items[0].id,'t');copy.page.items[0].text='changed';assert.equal(page.items[0].text,'文字');
  assert.deepEqual(reorderPages(copy.notebook,[...copy.notebook.pageIds].reverse()).pageIds,[copy.page.id,page.id]);
});
test('画像・文字の追加・移動・削除は同じUndo/Redo履歴で復元される',()=>{
  const p=fixture().pages[0],h=new History(),empty=pageContent(p);
  p.items=[{id:'t',type:'text',text:'文字',x:10,y:10,w:100,h:30,fontSize:22,color:'#123456'}];const added=pageContent(p);h.commit(empty,added);
  const ids=selectItems(p.items,[[0,0],[200,0],[200,200],[0,200]]);assert.deepEqual(ids,['t']);p.items=moveItems(p.items,ids,20,30,p.width,p.height);const moved=pageContent(p);h.commit(added,moved);
  p.items=[];h.commit(moved,pageContent(p));assert.deepEqual(h.undo(pageContent(p)),moved);assert.deepEqual(h.undo(moved),added);assert.deepEqual(h.undo(added),empty);assert.deepEqual(h.redo(empty),added);assert.ok(validPage({...p,...added}));
});
test('投げなわの線と画像を用紙端へ動かしても相対位置を維持する',()=>{
  const content={strokes:[{id:'s',size:2,points:[[10,10,.5],[20,20,.5]]}],items:[{id:'i',type:'image',x:40,y:40,w:50,h:50}]};
  const moved=moveContent(content,['s','i'],100,100,100,100);assert.deepEqual(moved.strokes[0].points[0],[20,20,.5]);assert.equal(moved.items[0].x,50);assert.equal(moved.items[0].y,50);
});
test('読み込みは10ページ以上のPDFの寸法と文字を取得しJPGを1冊にまとめる',async()=>{
  const pdf=new File(['%PDF-test'],'講義.pdf',{type:'application/pdf'}),jpg1=new File(['jpg'],'写真1.jpg'),jpg2=new File(['jpg'],'写真2.jpg');let destroyed=false;
  const records=await importFiles([pdf,jpg1,jpg2],null,{
    openPdf:async()=>({numPages:12,getPage:async n=>({getViewport:()=>({width:n%2?300:500,height:n%2?500:300}),getTextContent:async()=>({items:[{str:`page ${n}`,hasEOL:true}]}),cleanup(){}}),destroy:async()=>{destroyed=true;}}),
    prepareImage:async file=>({...fileRecord(file.name,jpeg()),width:400,height:200})
  });
  assert.equal(records.notebooks.length,2);assert.equal(records.pages.length,14);assert.equal(records.files.length,3);assert.equal(records.notebooks[1].pageIds.length,2);assert.equal(records.pages[11].text,'page 12\n');assert.equal(records.pages[1].width,500);assert.ok(destroyed);
});
test('途中で壊れた入力があれば読み込み結果を返さずPDFを解放する',async()=>{
  let destroyed=false;await assert.rejects(importFiles([new File(['%PDF-test'],'x.pdf')],null,{openPdf:async()=>({numPages:2,getPage:async()=>{throw new Error('broken');},destroy:async()=>{destroyed=true;}})}),/broken/);assert.ok(destroyed);
});
test('実PDF.jsが12ページの回転PDFを取り込み、ベクターPDF出力から文字を再抽出できる',async()=>{
  const source=await PDFDocument.create();
  for(let i=0;i<12;i++){const page=source.addPage([300,500]);if(i%2)page.setRotation(degrees(90));if(i!==11)page.drawText(`Original ${i+1}`,{x:30,y:40});}
  const file=new File([await source.save()],'12-pages.pdf',{type:'application/pdf'}),raw=await importFiles([file]);
  assert.equal(raw.pages.length,12);assert.deepEqual(raw.pages.slice(0,2).map(p=>[p.width,p.height]),[[300,500],[500,300]]);assert.match(raw.pages[0].text,/Original 1/);
  const bytes=await exportPdf(raw.pages,{getFile:async id=>raw.files.find(f=>f.id===id)}),pdf=await openPdf(new Blob([bytes]));
  try{assert.equal(pdf.numPages,12);const content=await (await pdf.getPage(2)).getTextContent();assert.match(content.items.map(t=>t.str).join(''),/Original 2/);}finally{await pdf.destroy();}
});
