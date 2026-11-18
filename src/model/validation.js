import { TEMPLATES } from './templates.js';
import { itemWidth, itemHeight, validateImageContents } from './images.js';
import { openPdf, validatePdfPage } from '../import/pdf.js';
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

// Use the same tolerant display engine as the editor, one page at a time.
export async function validatePdfContents(blob, { openPdf: open = openPdf } = {}) {
  const pdf = await open(blob);
  try {
    if (!pdf.numPages) throw new Error('PDFにページがありません');
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      try { await validatePdfPage(page); } finally { page.cleanup(); }
    }
    const count = pdf.numPages;
    return { getPageCount: () => count };
  } finally { await pdf.destroy(); }
}
