import { strokeOutline } from './strokes.js';
import { templateGeometry } from '../model/templates.js';
import { itemWidth, itemHeight, fitImage } from '../model/images.js';
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
  const outline = strokeOutline(stroke);
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
