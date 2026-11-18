import { PDFDocument, rgb, degrees, PDFName, PDFDict, PDFStream, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, rectangle, clip, endPath } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import { getStroke } from '../../vendor/perfect-freehand/index.mjs';
import { templateGeometry } from '../model/templates.js';
import { itemWidth, itemHeight, fitImage } from '../model/images.js';
import { pageAssets } from '../render/assets.js';
import { rasterSize } from './files.js';
const color = hex => rgb(...[1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255));
const key = PDFName.of;
// Match PDF.js's effective view box, including its disjoint-box fallback.
function viewBox(page) {
  const m = page.getMediaBox(), c = page.getCropBox();
  const left = Math.max(m.x, c.x), bottom = Math.max(m.y, c.y);
  const right = Math.min(m.x + m.width, c.x + c.width), top = Math.min(m.y + m.height, c.y + c.height);
  return right > left && top > bottom ? { left, bottom, right, top } : { left:m.x, bottom:m.y, right:m.x+m.width, top:m.y+m.height };
}
// Paint existing normal appearances into the private export copy. Unlike form.flatten(),
// this also covers non-widget annotations and honours display flags and AP matrices.
function flattenDisplayAppearances(page) {
  // V and AP can disagree even when an appearance stream exists. Without a font-
  // aware field renderer we cannot prove they agree (especially for Japanese).
  // Let PDF.js render all visible widgets instead of updating AP with pdf-lib.
  const acroForm = page.doc.catalog.lookup(key('AcroForm'));
  if (acroForm instanceof PDFDict && acroForm.lookup(key('NeedAppearances'))?.asBoolean?.() === true) return false;
  const annotations = page.node.Annots();
  if (!annotations) return true;
  const paints = [];
  for (let i = 0; i < annotations.size(); i++) {
    const annotation = annotations.lookup(i, PDFDict), flags = annotation.lookup(key('F'))?.asNumber() || 0;
    if (flags & (1 | 2 | 32)) continue; // Invisible, Hidden, NoView.
    const subtype = annotation.lookup(key('Subtype'))?.toString();
    if (subtype === '/Widget') return false;
    if (subtype === '/Popup' || subtype === '/Link') continue; // PDF.js canvas does not paint these.
    const ap = annotation.lookup(key('AP'));
    let appearance = ap instanceof PDFDict ? ap.lookup(key('N')) : null;
    if (appearance instanceof PDFDict) appearance = appearance.lookup(annotation.lookup(key('AS')) || key('Off'));
    // PDF.js can synthesize appearances. Use its display renderer for those pages.
    if (!(appearance instanceof PDFStream) || flags & (8 | 16)) return false;
    const rect = annotation.lookup(key('Rect'))?.asArray().map(n => n.asNumber());
    const box = appearance.dict.lookup(key('BBox'))?.asArray().map(n => n.asNumber());
    const matrix = appearance.dict.lookup(key('Matrix'))?.asArray().map(n => n.asNumber()) || [1,0,0,1,0,0];
    if (!rect || !box) return false;
    const [a,b,c,d,e,f] = matrix;
    const corners = [[box[0],box[1]],[box[0],box[3]],[box[2],box[1]],[box[2],box[3]]].map(([x,y]) => [a*x+c*y+e,b*x+d*y+f]);
    const x = Math.min(...corners.map(p=>p[0])), y = Math.min(...corners.map(p=>p[1]));
    const w = Math.max(...corners.map(p=>p[0]))-x, h = Math.max(...corners.map(p=>p[1]))-y;
    const left = Math.min(rect[0],rect[2]), bottom = Math.min(rect[1],rect[3]), width = Math.abs(rect[2]-rect[0]), height = Math.abs(rect[3]-rect[1]);
    if (!w || !h) return false;
    const sx = width/w, sy = height/h;
    paints.push({appearance,left,bottom,width,height,sx,sy,x,y});
  }
  for (const {appearance,left,bottom,width,height,sx,sy,x,y} of paints) {
    const name = page.node.newXObject('DisplayAppearance', page.doc.context.register(appearance));
    page.pushOperators(pushGraphicsState(), rectangle(left,bottom,width,height), clip(), endPath(), concatTransformationMatrix(sx,0,0,sy,left-sx*x,bottom-sy*y), drawObject(name), popGraphicsState());
  }
  page.node.delete(key('Annots'));
  return true;
}
// All coordinates here are PDF points. DOM work is provided by rasterizeText.
export async function exportPdf(pages, {getFile,rasterizeText,backgroundAssets = pageAssets}) {
  const pdf=await PDFDocument.create(), sources=new Map(), images=new Map(), appearances=new Map();
  async function image(id) {
    if (!images.has(id)) {
      const file=await getFile(id), bytes=await file.blob.arrayBuffer();
      images.set(id,file.mime==='image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes));
    }
    return images.get(id);
  }
  for (const page of pages) {
    const target=pdf.addPage([page.width,page.height]), bg=page.background;
    target.drawRectangle({x:0,y:0,width:page.width,height:page.height,color:rgb(1,1,1)});
    if (bg?.type==='pdf') {
      if (!sources.has(bg.fileId)) sources.set(bg.fileId,await PDFDocument.load(await (await getFile(bg.fileId)).blob.arrayBuffer()));
      const source=sources.get(bg.fileId).getPage(bg.pageIndex);
      if (!source) throw new Error('PDF背景のページがありません');
      const sourceKey = `${bg.fileId}:${bg.pageIndex}`;
      if (!appearances.has(sourceKey)) appearances.set(sourceKey, flattenDisplayAppearances(source));
      if (!appearances.get(sourceKey)) {
        const box = viewBox(source), unit = source.node.lookup(key('UserUnit'))?.asNumber() || 1;
        const { ratio } = rasterSize({width:(box.right-box.left)*unit,height:(box.top-box.bottom)*unit},144);
        const assets = await backgroundAssets({...page,items:[]},getFile,ratio);
        try {
          const blob = await new Promise((resolve,reject) => assets.background.toBlob(b => b ? resolve(b) : reject(new Error('PDF背景の画像化に失敗しました')), 'image/png'));
          const img = await pdf.embedPng(await blob.arrayBuffer());
          target.drawImage(img,{x:0,y:0,width:page.width,height:page.height});
        } finally { assets.release(); }
      // A valid blank PDF page can have no Contents stream to embed.
      } else if (source.node.Contents()) {
        const embedded=await pdf.embedPage(source,viewBox(source));
        const rotation=((source.getRotation().angle%360)+360)%360;
        // /Rotate is clockwise; embedding ignores it, so apply it explicitly.
        const rotated=rotation===90 || rotation===270;
        const w=rotated ? page.height : page.width, h=rotated ? page.width : page.height;
        const positions={0:[0,0],90:[0,page.height],180:[page.width,page.height],270:[page.width,0]};
        if (!positions[rotation]) throw new Error('PDFの回転角が不正です');
        target.drawPage(embedded,{x:positions[rotation][0],y:positions[rotation][1],width:w,height:h,rotate:degrees(-rotation)});
      }
    } else if (bg) {
      const img=await image(bg.fileId), box=bg.w ? bg : fitImage(img.width,img.height,page.width,page.height);
      target.drawImage(img,{x:box.x,y:page.height-box.y-box.h,width:box.w,height:box.h});
    }
    const geometry=templateGeometry(page.template,page.width,page.height);
    for (const [x1,y1,x2,y2] of geometry.lines) target.drawLine({start:{x:x1,y:page.height-y1},end:{x:x2,y:page.height-y2},thickness:.45,color:color('#dbe2df')});
    for (const [x,y] of geometry.dots) target.drawCircle({x,y:page.height-y,size:.65,color:color('#bbc9c3')});
    for (const stroke of page.strokes) {
      const highlight=stroke.tool==='highlighter', points=highlight ? stroke.points.map(([x,y]) => [x,y,.5]) : stroke.points;
      const outline=getStroke(points,{size:stroke.size,thinning:highlight ? 0 : .65,smoothing:.5,streamline:.3,simulatePressure:false,last:true});
      if (outline.length) target.drawSvgPath(outline.map(([x,y],i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ')+' Z',{x:0,y:page.height,color:color(stroke.color),opacity:highlight ? .35 : 1});
    }
    for (const item of page.items) {
      let img,w=itemWidth(item),h=itemHeight(item);
      if (item.type==='image') img=await image(item.fileId);
      else { const result=await rasterizeText(item); img=await pdf.embedPng(result.bytes); h=result.height ?? h; }
      target.drawImage(img,{x:item.x,y:page.height-item.y-h,width:w,height:h});
    }
  }
  return pdf.save();
}
