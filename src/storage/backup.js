import { validateRecords, validateFileContents } from '../model/validation.js';
export const STORES = ['folders','notebooks','pages','files'];
export function assertRecords(raw) {
  if (!raw || STORES.some(s => !Array.isArray(raw[s]))) throw new Error('必須ストアがありません');
  const checked = validateRecords(raw);
  if (checked.warnings.length) throw new Error(`バックアップの値・参照が不正です: ${checked.warnings.join(' / ')}`);
  return Object.fromEntries(STORES.map(s => [s, checked[s]]));
}
function encode(bytes) {
  let text = ''; for (let i=0;i<bytes.length;i+=32768) text += String.fromCharCode(...bytes.subarray(i,i+32768));
  return btoa(text);
}
export function decodeBase64(text) {
  if (typeof text !== 'string' || !text.length || text.length % 4) throw new Error('base64が不正です');
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0, end = text.length - padding;
  let last = 0;
  for (let i = 0; i < end; i++) {
    const c = text.charCodeAt(i);
    last = c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 71 : c >= 48 && c <= 57 ? c + 4 : c === 43 ? 62 : c === 47 ? 63 : -1;
    if (last < 0) throw new Error('base64が不正です');
  }
  if ((padding === 2 && (last & 15)) || (padding === 1 && (last & 3))) throw new Error('base64が非正規です');
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function createBackup(raw, now = new Date()) {
  const records = assertRecords(raw), files = [];
  const used = new Set(records.pages.flatMap(page => [
    ...(page.background ? [page.background.fileId] : []),
    ...page.items.filter(item => item.type === 'image').map(item => item.fileId)
  ]));
  records.files = records.files.filter(file => used.has(file.id));
  for (const { blob, editingLeases, sha256:oldHash, byteLength:oldLength, ...record } of records.files) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    files.push({ ...record, base64:encode(bytes), byteLength:bytes.length, sha256:await sha256(bytes) });
  }
  return { format:'tegaki-backup', version:2, createdAt:now.toISOString(), counts:Object.fromEntries(STORES.map(s => [s, records[s].length])), ...records, files };
}
export function validateBackup(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  if (!data || data.format !== 'tegaki-backup' || ![1,2].includes(data.version) || typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt))) throw new Error('バックアップ形式・版数・作成日時が不正です');
  if (STORES.some(s => !Array.isArray(data[s]) || !Number.isSafeInteger(data.counts?.[s]) || data.counts[s] !== data[s].length)) throw new Error('必須ストアまたは件数が不正です');
  const files = [];
  for (const file of data.files) {
    if (!file || typeof file !== 'object') throw new Error('ファイルが不正です');
    const { base64, sha256, byteLength, ...record } = file;
    if (data.version === 2 && (!Number.isSafeInteger(byteLength) || byteLength <= 0 || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))) throw new Error('ファイルのSHA-256・バイト長が不正です');
    files.push({ ...record, blob:new Blob([decodeBase64(base64)], { type:record.mime }) });
  }
  return assertRecords({ ...data, files });
}
// Keep the synchronous structure validator for callers inspecting metadata.
// Restoring must use this full preflight, including the decoded file bodies.
export async function prepareBackupRestore(input, options) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  const records = validateBackup(data);
  // Verify every file before parsing or replacing stores. Missing v2 integrity
  // fields must never silently downgrade to the legacy path.
  if (data.version === 2) {
    for (let i = 0; i < records.files.length; i++) {
      const file = records.files[i], expected = data.files[i];
      const bytes = new Uint8Array(await file.blob.arrayBuffer());
      if (bytes.length !== expected.byteLength || await sha256(bytes) !== expected.sha256)
        throw new Error(`バックアップのファイル「${file.name}」を読めません: SHA-256またはバイト長が一致しません`);
    }
  }
  // Also check page references and decodability, including legacy v1 files.
  return validateFileContents(records, options);
}
export function backupName(date = new Date()) {
  const pad = n => String(n).padStart(2,'0');
  return `tegaki-backup-${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
}
