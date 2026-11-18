import { dimensions } from './templates.js';
export const uid = () => crypto.randomUUID();
export const clone = value => structuredClone(value);
export function createPage(notebookId, { template = 'blank', orientation = 'portrait', width, height } = {}, makeId = uid) {
  return { id: makeId(), notebookId, ...dimensions(orientation), ...(width && height ? { width, height } : {}), template, background: null, strokes: [], items: [], bookmarked: false, text: '' };
}
export function createNotebook({ name = '新しいノート', folderId = null, coverColor = '#52796f', template = 'blank', orientation = 'portrait' } = {}, makeId = uid, now = Date.now()) {
  const id = makeId(), page = createPage(id, { template, orientation }, makeId);
  return { notebook: { id, name: name.trim() || '新しいノート', folderId, coverColor, createdAt: now, updatedAt: now, pageIds: [page.id] }, pages: [page] };
}
export function duplicateNotebook(notebook, pages, makeId = uid, now = Date.now()) {
  const copy = { ...clone(notebook), id: makeId(), name: `${notebook.name} のコピー`, createdAt: now, updatedAt: now };
  const copies = notebook.pageIds.map(id => {
    const page = clone(pages.find(p => p.id === id));
    if (!page) throw new Error('複製するページがありません');
    page.id = makeId(); page.notebookId = copy.id;
    page.strokes.forEach(s => { s.id = makeId(); });
    page.items.forEach(i => { i.id = makeId(); });
    return page;
  });
  copy.pageIds = copies.map(p => p.id);
  return { notebook: copy, pages: copies };
}
export function addPage(notebook, pages, afterId = null, makeId = uid) {
  const model = pages.find(p => p.id === (afterId || notebook.pageIds.at(-1)));
  const page = createPage(notebook.id, model || {}, makeId);
  const next = clone(notebook);
  if (afterId && !next.pageIds.includes(afterId)) throw new Error('指定ページがありません');
  const index = afterId ? next.pageIds.indexOf(afterId) + 1 : next.pageIds.length;
  next.pageIds.splice(index, 0, page.id); next.updatedAt = Date.now();
  return { notebook: next, pages: [...pages, page], page };
}
export function removePage(notebook, pages, pageId) {
  if (!notebook.pageIds.includes(pageId)) throw new Error('指定ページがありません');
  if (notebook.pageIds.length <= 1) throw new Error('最後の1ページは削除できません');
  return { notebook: { ...notebook, pageIds: notebook.pageIds.filter(id => id !== pageId), updatedAt: Date.now() }, pages: pages.filter(p => p.id !== pageId) };
}
export function reorderPages(notebook, ids) {
  if (ids.length !== notebook.pageIds.length || new Set(ids).size !== ids.length || ids.some(id => !notebook.pageIds.includes(id))) throw new Error('ページ順が不正です');
  return { ...notebook, pageIds: [...ids], updatedAt: Date.now() };
}
export function duplicatePage(notebook, pages, pageId, makeId = uid) {
  const source = pages.find(p => p.id === pageId);
  if (!source || !notebook.pageIds.includes(pageId)) throw new Error('複製するページがありません');
  const page = clone(source); page.id = makeId();
  for (const item of [...page.strokes,...page.items]) item.id=makeId();
  const ids=[...notebook.pageIds]; ids.splice(ids.indexOf(pageId)+1,0,page.id);
  return { notebook:{...notebook,pageIds:ids,updatedAt:Date.now()}, pages:[...pages,page], page };
}
