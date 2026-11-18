import { strokeOutline } from './strokes.js';
import { templateGeometry } from '../model/templates.js';
import { itemWidth, itemHeight, fitImage } from '../model/images.js';
// Weak ownership lets erased strokes and unmounted pages be collected. Compare
// values, not IDs/array identity: live input mutates points, and history/joins can
// reuse IDs. Bounds checks never need to generate a perfect-freehand outline.
const strokeCache = new WeakMap();
function strokeGeometry(stroke) {
  const cached=strokeCache.get(stroke),points=stroke.points;
  if (cached && cached.size===stroke.size && cached.tool===stroke.tool && cached.points.length===points.length*3) {
    let same=true;
    for (let i=0;i<points.length;i++) {
      const p=points[i],offset=i*3;
      if (p[0]!==cached.points[offset] || p[1]!==cached.points[offset+1] || !Object.is(p[2],cached.points[offset+2])) { same=false;break; }
    }
    if (same) return cached;
  }
  const snapshot=new Array(points.length*3);
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for (let i=0;i<points.length;i++) {
    const [x,y,p]=points[i];snapshot[i*3]=x;snapshot[i*3+1]=y;snapshot[i*3+2]=p;
    left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
  }
  const pad=Math.max(1.5,stroke.size)*2+2;
  const geometry={size:stroke.size,tool:stroke.tool,points:snapshot,
    bounds:{x:left-pad,y:top-pad,w:right-left+pad*2,h:bottom-top+pad*2}};
  strokeCache.set(stroke,geometry);return geometry;
}
export function configureCanvas(canvas, page, scale, dpr = globalThis.devicePixelRatio || 1) {
  // Match CSS scale × DPR until the explicit per-layer memory/edge cap.
  const ratio = Math.min(dpr * scale, Math.sqrt(4000000 / (page.width * page.height)), 4096 / Math.max(page.width, page.height));
  canvas.width = Math.max(1, Math.floor(page.width * ratio)); canvas.height = Math.max(1, Math.floor(page.height * ratio));
  canvas.style.width = `${page.width * scale}px`; canvas.style.height = `${page.height * scale}px`;
  const ctx = canvas.getContext('2d'); ctx.setTransform(canvas.width / page.width, 0, 0, canvas.height / page.height, 0, 0); return ctx;
}
export function clearCanvas(ctx) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.restore(); }
export function drawStroke(ctx, stroke, selected = false) {
  const highlighter = stroke.tool === 'highlighter';
  const geometry=strokeGeometry(stroke);
  const outline = geometry.outline ??= strokeOutline(stroke);
  if (!outline.length) return;
  ctx.save(); ctx.globalAlpha = highlighter ? .35 : 1; ctx.fillStyle = stroke.color;
  ctx.beginPath(); ctx.moveTo(...outline[0]);
  for (let i = 1; i < outline.length; i++) ctx.lineTo(...outline[i]);
  ctx.closePath(); ctx.fill();
  if (selected) { ctx.globalAlpha = .9; ctx.strokeStyle = '#278be0'; ctx.lineWidth = 1; ctx.setLineDash([3, 2]); ctx.stroke(); }
  ctx.restore();
}
export function textLines(ctx,item) {
  ctx.font=`${item.fontSize}px -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif`;
  const lines=[];
  for (const paragraph of item.text.split('\n')) {
    let line=''; for (const char of paragraph) { if (line && ctx.measureText(line+char).width > itemWidth(item)) { lines.push(line); line=''; } line+=char; } lines.push(line);
  }
  return lines;
}
export function drawText(ctx,item,x=item.x,y=item.y) {
  ctx.save(); ctx.fillStyle=item.color; ctx.textBaseline='top';
  const lines=textLines(ctx,item); lines.forEach((line,index) => ctx.fillText(line,x,y+index*item.fontSize*1.3)); ctx.restore(); return lines.length*item.fontSize*1.3;
}
const intersects = (a, b) => a.x <= b.x+b.w && b.x <= a.x+a.w && a.y <= b.y+b.h && b.y <= a.y+a.h;
function strokeBounds(stroke) {
  return strokeGeometry(stroke).bounds;
}
function itemBounds(ctx,item) {
  if (item.type !== 'text') return {x:item.x,y:item.y,w:itemWidth(item),h:itemHeight(item)};
  // Wrapping and glyph overhang can extend beyond the saved selection rectangle.
  ctx.save();
  const lines=textLines(ctx,item),pad=item.fontSize;
  const width=Math.max(itemWidth(item),...lines.map(line=>ctx.measureText(line).width));
  ctx.restore();
  return {x:item.x-pad,y:item.y-pad,w:width+pad*2,h:Math.max(itemHeight(item),lines.length*item.fontSize*1.3)+pad*2};
}
export function drawStrokePreview(ctx, page, stroke, assets = {}) {
  if (!stroke.points.length) return;
  const bounds=strokeBounds(stroke);
  const boxes=page.items.map(item=>({item,bounds:itemBounds(ctx,item)}));
  const regions=boxes.filter(box=>intersects(box.bounds,bounds)).map(box=>{
    const x=Math.max(bounds.x,box.bounds.x),y=Math.max(bounds.y,box.bounds.y);
    return {x,y,w:Math.min(bounds.x+bounds.w,box.bounds.x+box.bounds.w)-x,
      h:Math.min(bounds.y+bounds.h,box.bounds.y+box.bounds.h)-y};
  });
  drawStroke(ctx,stroke);
  if (!regions.length) return;
  // Align the opaque replacement to device pixels to avoid translucent clip seams.
  const rx=ctx.canvas.width/page.width,ry=ctx.canvas.height/page.height;
  for (const region of regions) {
    const right=Math.ceil((region.x+region.w)*rx)/rx,bottom=Math.ceil((region.y+region.h)*ry)/ry;
    region.x=Math.floor(region.x*rx)/rx;region.y=Math.floor(region.y*ry)/ry;
    region.w=right-region.x;region.h=bottom-region.y;
  }
  const touches=box=>regions.some(region=>intersects(box,region));
  const items=boxes.filter(box=>touches(box.bounds)).map(box=>box.item);
  const strokes=page.strokes.filter(s=>s.id!==stroke.id && touches(strokeBounds(s)));
  // Recompose the union of item intersections once. Ink outside these small
  // regions stays on the transparent live layer; overlapping translucent items
  // are never painted twice. PDF backgrounds reuse assets.background's bitmap.
  ctx.save();
  ctx.beginPath();for (const region of regions) ctx.rect(region.x,region.y,region.w,region.h);ctx.clip();
  renderPage(ctx,{...page,strokes:[...strokes,stroke],items},[],assets);
  ctx.restore();
}
export function renderPage(ctx, page, selected = [], assets = {}) {
  clearCanvas(ctx); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, page.width, page.height);
  if (assets.background) {
    const bg=page.background;
    const box=bg.type==='pdf' ? {x:0,y:0,w:page.width,h:page.height} : bg.w ? bg : fitImage(assets.background.naturalWidth,assets.background.naturalHeight,page.width,page.height);
    ctx.drawImage(assets.background,box.x,box.y,box.w,box.h);
  }
  const geometry = templateGeometry(page.template, page.width, page.height);
  ctx.strokeStyle = '#dbe2df'; ctx.lineWidth = .45; ctx.beginPath();
  for (const [x1, y1, x2, y2] of geometry.lines) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); } ctx.stroke();
  ctx.fillStyle = '#bbc9c3'; ctx.beginPath();
  for (const [x, y] of geometry.dots) { ctx.moveTo(x + .65, y); ctx.arc(x, y, .65, 0, 2 * Math.PI); } ctx.fill();
  for (const stroke of page.strokes) drawStroke(ctx, stroke, selected.includes(stroke.id));
  for (const item of page.items) {
    if (item.type==='text') drawText(ctx,item);
    else if (assets.images?.has(item.fileId)) ctx.drawImage(assets.images.get(item.fileId),item.x,item.y,itemWidth(item),itemHeight(item));
    if (selected.includes(item.id)) { ctx.save(); ctx.strokeStyle='#278be0'; ctx.lineWidth=1; ctx.setLineDash([3,2]); ctx.strokeRect(item.x,item.y,itemWidth(item),itemHeight(item)); ctx.restore(); }
  }
}
export function releaseCanvas(canvas) { canvas.width = 0; canvas.height = 0; canvas.remove(); }
