import { pageAssets } from '../render/assets.js';
import { renderPage,drawText,textLines } from '../render/page.js';
import { canvasBlob } from '../import/images.js';
import { rasterSize } from './files.js';
import { itemWidth } from '../model/images.js';
export async function rasterizePage(page,getFile, dpi=200) {
  const canvas=document.createElement('canvas'), size=rasterSize(page,dpi); canvas.width=size.width; canvas.height=size.height;
  let assets;
  try {
    assets=await pageAssets(page,getFile,size.ratio); const ctx=canvas.getContext('2d'); ctx.setTransform(size.width/page.width,0,0,size.height/page.height,0,0); renderPage(ctx,page,[],assets);
    return await canvasBlob(canvas);
  } finally { assets?.release(); canvas.width=canvas.height=0; }
}
export async function rasterizeText(item) {
  const canvas=document.createElement('canvas'), ctx=canvas.getContext('2d'), height=textLines(ctx,item).length*item.fontSize*1.3;
  const size=rasterSize({width:itemWidth(item),height},300); canvas.width=size.width; canvas.height=size.height;
  try { ctx.setTransform(size.width/itemWidth(item),0,0,size.height/height,0,0); drawText(ctx,item,0,0); return {bytes:await (await canvasBlob(canvas,'image/png')).arrayBuffer(),height}; }
  finally {canvas.width=canvas.height=0;}
}
