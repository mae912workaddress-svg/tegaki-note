import { jpegInfo, pngInfo, checkImageSize, validateImageContents } from '../model/images.js';
import { uid } from '../model/notebooks.js';
export async function loadImage(blob, checked = false) {
  if (!checked) {
    const bytes=new Uint8Array(await blob.arrayBuffer());
    if(bytes[0]===255 && bytes[1]===216)jpegInfo(bytes);else pngInfo(bytes);
  }
  const url = URL.createObjectURL(blob), image = new Image();
  try { image.src = url; await image.decode(); checkImageSize(image.naturalWidth,image.naturalHeight); return image; }
  finally { URL.revokeObjectURL(url); }
}
export function canvasBlob(canvas, type = 'image/jpeg', quality = .92) {
  return new Promise((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('画像の作成に失敗しました')),type,quality));
}
export async function prepareImage(file, allowPng = false, options) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const jpeg = bytes[0] === 255 && bytes[1] === 216;
  if (jpeg) jpegInfo(bytes); else if (allowPng) pngInfo(bytes); else throw new Error('対応形式はPDF・JPGです');
  await validateImageContents(new Blob([bytes], { type:jpeg ? 'image/jpeg' : 'image/png' }), options);
  // Safari/HTMLImageElement applies EXIF (including mirrored orientations).
  // Re-encoding removes EXIF so screen and PDF use the same oriented pixels.
  const image = await loadImage(new Blob([bytes], { type:jpeg ? 'image/jpeg' : 'image/png' }),true);
  const ratio = Math.min(1, 4096 / Math.max(image.naturalWidth,image.naturalHeight));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1,Math.round(image.naturalWidth*ratio)); canvas.height = Math.max(1,Math.round(image.naturalHeight*ratio));
  try {
    canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    const mime = jpeg ? 'image/jpeg' : 'image/png', blob = await canvasBlob(canvas,mime);
    return { id:uid(), name:file.name || '画像', mime, blob, width:canvas.width, height:canvas.height };
  } finally { canvas.width=canvas.height=0; image.src=''; }
}
