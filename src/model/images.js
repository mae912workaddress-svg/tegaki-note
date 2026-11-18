import { dimensions } from './templates.js';
export const MAX_IMAGE_PIXELS = 50000000;
export function checkImageSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS || Math.max(width, height) > 65535) throw new Error('画像が大きすぎるか寸法が不正です（上限5000万画素）');
}
// Read only bounded JPEG segments. XMP must not overwrite an EXIF orientation.
export function jpegInfo(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] !== 255 || b[1] !== 216) throw new Error('JPEGではありません');
  let offset = 2, width, height, orientation;
  while (offset < b.length) {
    if (b[offset++] !== 255) throw new Error('JPEGヘッダーが壊れています');
    while (b[offset] === 255) offset++;
    const marker = b[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > b.length) throw new Error('JPEGヘッダーが途切れています');
    const length = v.getUint16(offset), start = offset + 2, end = offset + length;
    if (length < 2 || end > b.length) throw new Error('JPEGヘッダー長が不正です');
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 8) throw new Error('JPEG寸法がありません');
      height = v.getUint16(start + 1); width = v.getUint16(start + 3);
      checkImageSize(width, height);
    }
    if (marker === 0xe1 && orientation === undefined && end - start >= 14 && b.slice(start, start + 6).every((n,i) => n === [69,120,105,102,0,0][i])) {
      const t = start + 6, little = v.getUint16(t) === 0x4949;
      if (little || v.getUint16(t) === 0x4d4d) {
        const u16 = p => { if (p < t || p + 2 > end) throw new Error('EXIFが壊れています'); return v.getUint16(p, little); };
        const u32 = p => { if (p < t || p + 4 > end) throw new Error('EXIFが壊れています'); return v.getUint32(p, little); };
        if (u16(t + 2) === 42) {
          const dir = t + u32(t + 4), count = u16(dir);
          if (dir + 2 + count * 12 > end) throw new Error('EXIF一覧が壊れています');
          for (let i = 0; i < count; i++) {
            const p = dir + 2 + i * 12;
            if (u16(p) === 0x112 && u16(p + 2) === 3 && u32(p + 4) === 1) { const n = u16(p + 8); if (n >= 1 && n <= 8) { orientation = n; break; } }
          }
        }
      }
    }
    offset = end;
  }
  checkImageSize(width, height);
  orientation ??= 1;
  return { width, height, orientation, displayWidth: orientation >= 5 ? height : width, displayHeight: orientation >= 5 ? width : height };
}
export function pngInfo(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 33 || ![137,80,78,71,13,10,26,10].every((n,i) => b[i] === n) || String.fromCharCode(...b.slice(12,16)) !== 'IHDR') throw new Error('PNGが壊れています');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), width = v.getUint32(16), height = v.getUint32(20);
  checkImageSize(width, height); return { width, height };
}
const pngCrcTable = Uint32Array.from({length:256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function pngBody(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), chunks = [];
  let offset = 8, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), end = offset + 8 + length;
    if (end + 4 > bytes.length) throw new Error('PNGチャンクが途切れています');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) throw new Error('PNGのIHDRが不正です');
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end; i++) {
      crc = (crc >>> 8) ^ pngCrcTable[(crc ^ bytes[i]) & 255];
    }
    if ((~crc >>> 0) !== view.getUint32(end)) throw new Error('PNGのCRCが不正です');
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, end));
    offset = end + 4;
    if (type === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
  }
  if (!ended || !chunks.length) throw new Error('PNGの画像本体またはIENDがありません');
  return chunks;
}
function pngScanlines(bytes, info) {
  const depth = bytes[24], color = bytes[25], interlace = bytes[28];
  const channels = {0:1,2:3,3:1,4:2,6:4}[color];
  const allowed = {0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]}[color];
  if (!allowed?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) throw new Error('PNGの画素形式が不正です');
  const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  return passes.map(([x,y,dx,dy]) => {
    const width = Math.max(0,Math.ceil((info.width-x)/dx)), height = Math.max(0,Math.ceil((info.height-y)/dy));
    return { row:Math.ceil(width*channels*depth/8)+1, height:width ? height : 0 };
  });
}
function jpegBody(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2, scans = 0, entropy = 0;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) throw new Error('JPEGマーカーが不正です');
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!scans || !entropy) throw new Error('JPEGの画像本体がありません');
      return;
    }
    if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) throw new Error('JPEGの構造が不正です');
    if (marker === 1) continue;
    if (offset + 2 > bytes.length) throw new Error('JPEGが途切れています');
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error('JPEGセグメントが途切れています');
    if (marker === 0xda && (length < 6 || length !== 6 + 2 * bytes[offset + 2])) throw new Error('JPEGのSOSが不正です');
    offset += length;
    if (marker === 0xda) {
      scans++;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { entropy++; offset++; continue; }
        if (bytes[offset + 1] === 0) { entropy++; offset += 2; continue; }
        if (bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7) { offset += 2; continue; }
        break;
      }
    }
  }
  throw new Error('JPEGのEOIがありません');
}
// Browser preflight always decodes pixels; Node uses a bounded structural fallback.
// An injected decoder returns a bitmap (close) or an HTML image (src) to release.
export async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  if (typeof Image === 'function') {
    const image = new Image(), url = URL.createObjectURL(blob);
    try { image.src = url; await image.decode(); return image; }
    catch (error) { image.src = ''; throw error; }
    finally { URL.revokeObjectURL(url); }
  }
  return null;
}
export async function validateImageContents(blob, { decode = decodeImage } = {}) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const jpeg = blob.type === 'image/jpeg' || (!blob.type && bytes[0] === 255 && bytes[1] === 216);
  const info = jpeg ? jpegInfo(bytes) : pngInfo(bytes);
  const chunks = jpeg ? (jpegBody(bytes), null) : pngBody(bytes);
  const image = await decode(blob);
  if (image) {
    try { checkImageSize(image.naturalWidth ?? image.width, image.naturalHeight ?? image.height); }
    finally { if (typeof image.close === 'function') image.close(); else image.src = ''; }
  } else if (typeof process !== 'undefined' && process.versions?.node) {
    if (chunks) {
      const { inflateSync } = await import('node:zlib');
      const passes = pngScanlines(bytes,info), expected = passes.reduce((n,p) => n+p.row*p.height,0);
      const compressed = new Uint8Array(chunks.reduce((n,c) => n+c.length,0));
      let start = 0; for (const chunk of chunks) { compressed.set(chunk,start); start += chunk.length; }
      const decoded = inflateSync(compressed, { maxOutputLength:expected });
      if (decoded.length !== expected) throw new Error('PNGの画素データが途切れています');
      let offset = 0;
      for (const pass of passes) for (let row = 0; row < pass.height; row++) {
        if (decoded[offset] > 4) throw new Error('PNGのフィルターが不正です');
        offset += pass.row;
      }
    }
  } else throw new Error('画像デコーダーを利用できません');
  return info;
}
export function fitImage(width, height, pageWidth, pageHeight) {
  if (![width,height,pageWidth,pageHeight].every(n => Number.isFinite(n) && n > 0)) throw new Error('画像寸法が不正です');
  const ratio = Math.min(pageWidth / width, pageHeight / height), w = width * ratio, h = height * ratio;
  return { x: (pageWidth - w) / 2, y: (pageHeight - h) / 2, w, h };
}
export function imagePageLayout(width, height) { const page = dimensions(width > height ? 'landscape' : 'portrait'); return { ...page, placement: fitImage(width, height, page.width, page.height) }; }
export const itemWidth = item => item.w ?? item.width;
export const itemHeight = item => item.h ?? item.height ?? Math.max(item.fontSize * 1.3, item.text.split('\n').length * item.fontSize * 1.3);
