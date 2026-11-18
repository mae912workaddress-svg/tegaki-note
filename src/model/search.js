export const normalizeSearch = text => text.normalize('NFKC').toLocaleLowerCase('ja');
export function excerpt(text, query, radius = 28) {
  const normalized = normalizeSearch(text), index = normalized.indexOf(normalizeSearch(query));
  if (index < 0) return null;
  // Map normalized offsets back to complete original graphemes (e.g. ｶﾞ, ㍿).
  const spans = [];
  let offset = 0;
  for (const { segment, index: original } of new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text)) {
    const length = normalizeSearch(segment).length;
    spans.push({ from: offset, to: offset + length, start: original, end: original + segment.length });
    offset += length;
  }
  const left = Math.max(0, index - radius), right = Math.min(normalized.length, index + normalizeSearch(query).length + radius);
  const start = spans.find(s => s.to > left)?.start ?? 0;
  const end = spans.findLast(s => s.from < right)?.end ?? text.length;
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
export function searchNotes(notebooks, pages, query) {
  if (!query.trim()) return [];
  const byId = new Map(pages.map(p => [p.id,p])), results = [];
  for (const n of notebooks) {
    const title = excerpt(n.name, query);
    if (title !== null) results.push({ notebookId:n.id, name:n.name, pageId:n.pageIds[0], pageNumber:1, snippet:title });
    n.pageIds.forEach((id,index) => {
      const p = byId.get(id); if (!p) return;
      const snippet = excerpt([p.text, ...p.items.filter(i => i.type === 'text').map(i => i.text)].join('\n'), query);
      if (snippet !== null) results.push({ notebookId:n.id, name:n.name, pageId:id, pageNumber:index+1, snippet });
    });
  }
  return results;
}
