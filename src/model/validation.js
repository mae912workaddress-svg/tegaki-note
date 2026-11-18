import { TEMPLATES } from './templates.js';
import { itemWidth, itemHeight, validateImageContents } from './images.js';
import { PDFDocument, PDFArray, PDFDict, PDFName, PDFRef, PDFRawStream, decodePDFRawStream } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 200;
const name = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 500;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const date = v => finite(v) && v >= 0 && v <= 8640000000000000;
export const validColor = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const uniqueIds = list => Array.isArray(list) && list.every(id) && new Set(list).size === list.length;
export function validFolder(v) { return object(v) && id(v.id) && name(v.name) && Number.isSafeInteger(v.order) && v.order >= 0 && date(v.createdAt) && date(v.updatedAt); }
export function validNotebook(v) { return object(v) && id(v.id) && name(v.name) && (v.folderId === null || id(v.folderId)) && validColor(v.coverColor) && date(v.createdAt) && date(v.updatedAt) && uniqueIds(v.pageIds) && v.pageIds.length > 0; }
export function validStroke(v, width, height) {
  return object(v) && id(v.id) && ['pen', 'highlighter'].includes(v.tool) && validColor(v.color) && finite(v.size) && v.size > 0 && v.size <= 200 && Array.isArray(v.points) && v.points.length > 0 && v.points.every(p => Array.isArray(p) && p.length === 3 && p.every(finite) && p[0] >= 0 && p[0] <= width && p[1] >= 0 && p[1] <= height && p[2] >= 0 && p[2] <= 1);
}
export function validFile(v) { return object(v) && id(v.id) && typeof v.name === 'string' && ['application/pdf', 'image/jpeg', 'image/png'].includes(v.mime) && v.blob instanceof Blob && v.blob.size > 0 && (!v.blob.type || v.blob.type === v.mime); }
function validItem(v) {
  if (!object(v) || !id(v.id) || !['image', 'text'].includes(v.type) || ![v.x, v.y, itemWidth(v)].every(finite) || itemWidth(v) <= 0 || itemWidth(v) > 10000) return false;
  if (v.type === 'text' && (typeof v.text !== 'string' || !validColor(v.color) || !finite(v.fontSize) || v.fontSize <= 0 || v.fontSize > 200)) return false;
  return finite(itemHeight(v)) && itemHeight(v) > 0 && itemHeight(v) <= 10000 && (v.type !== 'image' || id(v.fileId));
}
export function validPage(v) {
  if (!object(v) || !id(v.id) || !id(v.notebookId) || !finite(v.width) || !finite(v.height) || v.width <= 0 || v.height <= 0 || v.width > 10000 || v.height > 10000 || typeof v.template !== 'string' || !Object.hasOwn(TEMPLATES, v.template)) return false;
  const bg = v.background;
  if (bg !== null && !(object(bg) && id(bg.fileId) && (bg.type === 'image' || (bg.type === 'pdf' && Number.isSafeInteger(bg.pageIndex) && bg.pageIndex >= 0)))) return false;
  if (bg?.type === 'image' && ['x','y','w','h'].some(k => Object.hasOwn(bg,k)) && (![bg.x,bg.y,bg.w,bg.h].every(finite) || bg.w <= 0 || bg.h <= 0)) return false;
  return Array.isArray(v.strokes) && v.strokes.every(s => validStroke(s, v.width, v.height)) && uniqueIds(v.strokes.map(s => s.id)) && Array.isArray(v.items) && v.items.every(validItem) && uniqueIds(v.items.map(i => i.id)) && typeof v.bookmarked === 'boolean' && typeof v.text === 'string';
}
export function validateRecords(raw) {
  const result = { folders: [], notebooks: [], pages: [], files: [], warnings: [] };
  for (const [store, check] of Object.entries({ folders: validFolder, notebooks: validNotebook, pages: validPage, files: validFile })) {
    const seen = new Set();
    if (!Array.isArray(raw[store])) { result.warnings.push(`${store}: データ一覧が不正です`); continue; }
    for (const value of raw[store]) {
      if (!check(value) || seen.has(value.id)) result.warnings.push(`${store}: 不正なレコードを表示から除外しました（${String(value?.id ?? 'IDなし')}）`);
      else { seen.add(value.id); result[store].push(value); }
    }
  }
  const folders = new Set(result.folders.map(f => f.id)), files = new Map(result.files.map(f => [f.id, f]));
  const reject = (store, predicate) => {
    result[store] = result[store].filter(v => { if (predicate(v)) return true; result.warnings.push(`${store}: 参照先が不正です（${v.id}）`); return false; });
  };
  reject('pages', p => (!p.background || (files.has(p.background.fileId) && (p.background.type === 'pdf' ? files.get(p.background.fileId).mime === 'application/pdf' : files.get(p.background.fileId).mime.startsWith('image/')))) && p.items.every(i => i.type !== 'image' || files.get(i.fileId)?.mime.startsWith('image/')));
  let changed;
  do {
    const count = result.notebooks.length + result.pages.length;
    const pages = new Map(result.pages.map(p => [p.id, p]));
    reject('notebooks', n => (n.folderId === null || folders.has(n.folderId)) && n.pageIds.every(pid => pages.get(pid)?.notebookId === n.id));
    const notebooks = new Map(result.notebooks.map(n => [n.id, n]));
    reject('pages', p => notebooks.get(p.notebookId)?.pageIds.includes(p.id));
    changed = count !== result.notebooks.length + result.pages.length;
  } while (changed);
  return result;
}

// Restore preflight: finish all asynchronous parsing before opening a write transaction.
export async function validateFileContents(records, options) {
  const pdfCounts = new Map();
  for (const file of records.files) {
    try {
      if (file.mime === 'application/pdf') {
        const pdf = await validatePdfContents(file.blob, options);
        pdfCounts.set(file.id, pdf.getPageCount());
      } else await validateImageContents(file.blob, options);
    } catch (error) { throw new Error(`バックアップのファイル「${file.name}」を読めません: ${error.message}`); }
  }
  for (const page of records.pages) {
    const bg = page.background;
    if (bg?.type === 'pdf' && bg.pageIndex >= pdfCounts.get(bg.fileId)) throw new Error('バックアップのPDFページ参照が範囲外です');
  }
  return records;
}

// Only import/restore call this preflight. Never cache decoded stream bodies.
export async function validatePdfContents(blob, { maxStreamBytes = 200 * 1024 * 1024, maxTotalBytes = 1024 * 1024 * 1024, decodeFlate = decompressFlate } = {}) {
  const pdf = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), { throwOnInvalidObject: true });
  if (!pdf.getPageCount()) throw new Error('PDFにページがありません');
  const visited = new Set(), pending = [];
  const budget = { remaining:maxTotalBytes, maxStreamBytes };
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    if (![width, height].every(n => Number.isFinite(n) && n > 0)) throw new Error('PDFのページ寸法が不正です');
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray
      ? Array.from({ length:contents.size() }, (_, i) => contents.lookup(i)) : [contents];
    for (const stream of streams) {
      if (stream === undefined && contents === undefined) continue;
      if (!(stream instanceof PDFRawStream)) throw new Error('PDFの本文ストリームが不正です');
    }
    pending.push(page.node.Resources()); // Include inherited resources as well.
    for (const [key, child] of page.node.entries()) {
      if (key !== PDFName.of('Parent')) pending.push(child);
    }
  }
  // Iterative traversal handles shared/cyclic Forms, Patterns, font descriptors,
  // soft masks, Shading functions and annotation appearance dictionaries alike.
  while (pending.length) {
    let value = pending.pop();
    if (value instanceof PDFRef) {
      value = pdf.context.lookup(value);
      if (!value) throw new Error('PDFの参照先がありません');
    }
    if (!value || visited.has(value)) continue;
    visited.add(value);
    if (value instanceof PDFRawStream) {
      await validateStream(value, budget, decodeFlate); pending.push(value.dict);
    } else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) pending.push(value.get(i));
    } else if (value instanceof PDFDict) {
      // Annotation /P and field parents may link back to page trees. Check the
      // target type, not the key: a perfectly valid Pattern/XObject can be /P.
      const type = value.get(PDFName.of('Type'));
      if (type instanceof PDFName && ['/Page','/Pages'].includes(type.asString())) continue;
      for (const [, child] of value.entries()) pending.push(child);
    }
  }
  return pdf;
}

const filterNames = { Fl:'FlateDecode', LZW:'LZWDecode', AHx:'ASCIIHexDecode', A85:'ASCII85Decode', RL:'RunLengthDecode', DCT:'DCTDecode' };
const supportedFilters = new Set(['FlateDecode','LZWDecode','ASCIIHexDecode','ASCII85Decode','RunLengthDecode']);
async function validateStream(raw, budget, decodeFlate) {
  let bytes = raw.getContents();
  const length = raw.dict.lookup(PDFName.of('Length'));
  if (length?.asNumber?.() !== bytes.length) throw new Error('PDFのストリーム長が不正です');
  const filter = raw.dict.lookup(PDFName.of('Filter')), params = raw.dict.lookup(PDFName.of('DecodeParms'));
  const filters = filter instanceof PDFArray ? Array.from({length:filter.size()}, (_,i) => filter.lookup(i)) : filter ? [filter] : [];
  const checkSize = size => {
    if (size > budget.maxStreamBytes || size > budget.remaining) throw new Error('PDFのストリーム展開量が上限を超えました');
  };
  checkSize(bytes.length);
  if (!filters.length) { budget.remaining -= bytes.length; return; }
  for (let i = 0; i < filters.length; i++) {
    if (!(filters[i] instanceof PDFName)) throw new Error('PDFのフィルターが不正です');
    const name = filters[i].decodeText(), canonical = filterNames[name] || name;
    if (!supportedFilters.has(canonical)) {
      if (!bytes.length) throw new Error('PDFの画像ストリームがありません');
      if (canonical === 'DCTDecode') validateJpegStream(bytes);
      // JPX/JBIG2/CCITT and other codecs are handled by the rendering engine.
      // Their output cannot be passed to subsequent filters by this validator.
      budget.remaining -= bytes.length;
      return;
    }
    const dict = raw.dict.clone(); dict.set(PDFName.of('Filter'), PDFName.of(canonical));
    const param = params instanceof PDFArray ? params.lookup(i) : params;
    if (param) dict.set(PDFName.of('DecodeParms'), param); else dict.delete(PDFName.of('DecodeParms'));
    let decoder;
    try {
      if (canonical === 'FlateDecode') {
        bytes = await strictFlate(bytes, dict, decodeFlate, checkSize, Math.min(budget.maxStreamBytes, budget.remaining));
        checkSize(bytes.length);
        budget.remaining -= bytes.length;
        continue;
      }
      decoder = decodePDFRawStream(PDFRawStream.of(dict, bytes));
      const ensure = decoder.ensureBuffer.bind(decoder);
      // Guard allocations, not merely the final decoded length. Each stage of
      // a filter chain counts toward the total work/memory budget.
      decoder.ensureBuffer = size => { checkSize(size); return ensure(size); };
      while (!decoder.eof) { decoder.readBlock(); checkSize(decoder.bufferLength); }
      bytes = decoder.buffer.subarray(0, decoder.bufferLength);
      budget.remaining -= bytes.length;
    } catch (error) {
      if (error.message.includes('上限')) throw error;
      throw new Error('PDFの本文ストリームを展開できません');
    } finally {
      if (decoder) decoder.buffer = new Uint8Array(0);
    }
  }
}

// Read through EOF: a partial output is not proof of a complete zlib stream.
// Do not retry corrupt zlib as raw deflate: that would bypass its checksum.
async function decompressFlate(bytes, { maxOutputBytes }) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxOutputBytes) throw new Error('PDFのストリーム展開量が上限を超えました');
      chunks.push(value);
    }
    const output = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function strictFlate(bytes, dict, decode, checkSize, maxOutputBytes) {
  try { return await decode(bytes, { maxOutputBytes }); }
  catch (error) {
    if (error.message.includes('上限')) throw error;
    // Some DecompressionStream implementations reject trailing PDF whitespace
    // or garbage. Locate a candidate end only on failure, then validate that
    // exact prefix again with the STRICT decoder, including all four Adler bytes.
    // pdf-lib's permissive EOF is never itself accepted as validation.
    let locator;
    try {
      locator = decodePDFRawStream(PDFRawStream.of(dict, bytes));
      const ensure = locator.ensureBuffer.bind(locator);
      locator.ensureBuffer = size => { checkSize(size); return ensure(size); };
      while (!locator.eof) { locator.readBlock(); checkSize(locator.bufferLength); }
      // Huffman lookahead may have read whole bytes beyond the final block.
      const end = locator.stream.pos - Math.floor(locator.codeSize / 8) + 4;
      if (!Number.isSafeInteger(end) || end <= 0 || end >= bytes.length) throw error;
      locator.buffer = new Uint8Array(0);
      return await decode(bytes.subarray(0, end), { maxOutputBytes });
    } finally {
      if (locator) locator.buffer = new Uint8Array(0);
    }
  }
}

// JPEG marker/segment validation without allocating decoded pixels.
function validateJpegStream(bytes) {
  const fail = () => { throw new Error('PDFのJPEGストリームが不正です'); };
  if (bytes[0] !== 255 || bytes[1] !== 216) fail();
  let offset = 2, frame = false, scan = false, entropy = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) fail();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217) { if (!frame || !scan || !entropy) fail(); return; }
    if (!marker || marker === 216 || marker >= 208 && marker <= 215) fail();
    if (marker === 1) continue;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (!(length >= 2) || offset + length > bytes.length) fail();
    if (marker >= 192 && marker <= 207 && ![196,200,204].includes(marker)) {
      if (length < 8 || !((bytes[offset+3]*256+bytes[offset+4]) > 0) || !((bytes[offset+5]*256+bytes[offset+6]) > 0)) fail();
      frame = true;
    }
    if (marker === 218 && (length < 6 || length !== 6 + 2 * bytes[offset+2])) fail();
    offset += length;
    if (marker === 218) {
      scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 255) { entropy = true; offset++; }
        else if (bytes[offset+1] === 0 || bytes[offset+1] >= 208 && bytes[offset+1] <= 215) { entropy = true; offset += 2; }
        else break;
      }
    }
  }
  fail();
}
