import test from 'node:test';
import assert from 'node:assert/strict';
import { A4, MM, dimensions, templateGeometry } from '../src/model/templates.js';
import { createNotebook, addPage, removePage, duplicateNotebook, reorderPages } from '../src/model/notebooks.js';
import { pointInPolygon, selectStrokes, erasePartial, eraseAt, strokeHit, moveStrokes } from '../src/model/geometry.js';
import { History } from '../src/model/history.js';
import { validPage, validateRecords, validStroke, validFile } from '../src/model/validation.js';
const ids = () => { let n = 0; return () => `id-${++n}`; };
const stroke = (points, overrides = {}) => ({ id: 'stroke1', tool: 'pen', color: '#123456', size: 2, points, ...overrides });
const fixture = () => { const n = createNotebook({}, ids(), 100); return { folders: [], notebooks: [n.notebook], pages: n.pages, files: [] }; };
test('A4 縦横の寸法をptで返す', () => { assert.deepEqual(dimensions(), A4); assert.deepEqual(dimensions('landscape'), { width: 841.89, height: 595.28 }); assert.ok(Math.abs(A4.width - 210 * MM) < .01); });
test('方眼は5mm、横罫は7mm、ドットは5mm、無地は空', () => {
  const grid = templateGeometry('grid', A4.width, A4.height), ruled = templateGeometry('ruled', A4.width, A4.height), dot = templateGeometry('dot', A4.width, A4.height);
  assert.equal(grid.lines[0][0], 5 * MM); assert.equal(grid.lines[1][0] - grid.lines[0][0], 5 * MM);
  assert.ok(Math.abs(ruled.lines[1][1] - ruled.lines[0][1] - 7 * MM) < 1e-10); assert.equal(ruled.lines[0][1], 14 * MM);
  assert.equal(dot.dots[1][0] - dot.dots[0][0], 5 * MM);
  assert.deepEqual(templateGeometry('blank', 595, 842), { lines: [], dots: [] });
  for (const [x, y] of dot.dots) assert.ok(x > 0 && x < A4.width && y > 0 && y < A4.height);
  assert.throws(() => templateGeometry('grid', Infinity, 100));
});
test('横向きテンプレートは横向きの境界内に収まる', () => { const { width, height } = dimensions('landscape'); for (const line of templateGeometry('grid', width, height).lines) assert.ok(line[0] <= width && line[2] <= width && line[1] <= height && line[3] <= height); });
test('部分消去が疎な2点の線も円との交差で分割する', () => {
  const original = stroke([[0, 10, .2], [100, 10, .8]]), parts = erasePartial(original, [50, 10], 9, ids());
  assert.equal(parts.length, 2); assert.equal(parts[0].points.at(-1)[0], 40); assert.equal(parts[1].points[0][0], 60);
  assert.ok(Math.abs(parts[0].points.at(-1)[2] - .44) < 1e-10); assert.notEqual(parts[0].id, parts[1].id); assert.equal(original.points.length, 2);
});
test('部分消去は単点・全消去・非接触を扱う', () => {
  const s = stroke([[10, 10, .5]]); assert.deepEqual(erasePartial(s, [10, 10], 5), []); assert.equal(erasePartial(s, [100, 100], 5)[0], s);
  assert.deepEqual(erasePartial(stroke([[5, 5, .5], [6, 6, .5]]), [5, 5], 20), []);
});
test('線ごと消去は点間にも当たり、遠い線は維持する', () => { const s = stroke([[0, 10, .5], [100, 10, .5]]); assert.ok(strokeHit(s, [50, 10], 2)); assert.equal(eraseAt([s], [50, 10], 2).length, 0); assert.equal(eraseAt([s], [50, 40], 2).length, 1); });
test('投げなわの内外・境界・未閉鎖少数点を判定する', () => {
  const polygon = [[0, 0], [20, 0], [20, 20], [0, 20]];
  assert.equal(pointInPolygon([10, 10], polygon), true); assert.equal(pointInPolygon([30, 10], polygon), false); assert.equal(pointInPolygon([0, 0], polygon), true); assert.equal(pointInPolygon([0, 0], [[0, 0]]), false);
  assert.deepEqual(selectStrokes([stroke([[1, 1, .5], [10, 10, .5]]), stroke([[30, 30, .5]], { id: 'outside' })], polygon), ['stroke1']);
});
test('移動は筆圧と非選択線を保ち、用紙外へ出ない', () => { const s = stroke([[10, 10, .3], [20, 20, .7]]), other = stroke([[1, 1, .5]], { id: 'other' }); const moved = moveStrokes([s, other], ['stroke1'], -30, 200, 100, 100); assert.deepEqual(moved[0].points, [[0, 90, .3], [10, 100, .7]]); assert.equal(moved[1], other); });
test('複製はノート・ページ・ストローク・itemのIDを更新し内容を深いコピーにする', () => {
  const makeId = ids(), n = createNotebook({ name: '会議', orientation: 'landscape', template: 'grid' }, makeId, 100);
  n.pages[0].strokes.push(stroke([[1, 2, .6]])); n.pages[0].items.push({ id: 'item1', type: 'text', text: '議事録' });
  const copy = duplicateNotebook(n.notebook, n.pages, makeId, 200);
  assert.notEqual(copy.notebook.id, n.notebook.id); assert.notEqual(copy.pages[0].id, n.pages[0].id); assert.notEqual(copy.pages[0].strokes[0].id, 'stroke1'); assert.notEqual(copy.pages[0].items[0].id, 'item1');
  assert.deepEqual(copy.pages[0].strokes[0].points, n.pages[0].strokes[0].points); assert.equal(copy.pages[0].width, 841.89); assert.equal(copy.pages[0].notebookId, copy.notebook.id);
  copy.pages[0].strokes[0].points[0][0] = 99; assert.equal(n.pages[0].strokes[0].points[0][0], 1);
});
test('ページ追加・後ろに挿入・削除・並べ替えの整合性', () => {
  const makeId = ids(), n = createNotebook({ template: 'ruled', orientation: 'landscape' }, makeId);
  const b = addPage(n.notebook, n.pages, null, makeId), c = addPage(b.notebook, b.pages, n.pages[0].id, makeId);
  assert.equal(c.notebook.pageIds[1], c.page.id); assert.equal(c.page.template, 'ruled'); assert.equal(c.page.width, 841.89);
  const reordered = reorderPages(c.notebook, [...c.notebook.pageIds].reverse()); assert.equal(reordered.pageIds[0], b.page.id);
  assert.throws(() => reorderPages(c.notebook, [c.page.id, c.page.id, c.page.id]));
  const removed = removePage(c.notebook, c.pages, c.page.id); assert.equal(removed.pages.length, 2); assert.ok(!removed.notebook.pageIds.includes(c.page.id));
  assert.throws(() => removePage(n.notebook, n.pages, n.pages[0].id)); assert.throws(() => addPage(n.notebook, n.pages, 'missing'));
});
test('Undo/Redo は追加・削除・移動・分割と履歴分岐を扱う', () => {
  const h = new History(), first = [stroke([[0, 1, .5], [100, 1, .5]])], split = erasePartial(first[0], [50, 1], 9, ids());
  h.commit([], first); h.commit(first, split); assert.deepEqual(h.undo(split), first); assert.deepEqual(h.undo(first), []); assert.deepEqual(h.redo([]), first); assert.deepEqual(h.redo(first), split);
  const moved = moveStrokes(split, [split[0].id], 1, 1, 200, 200); h.commit(split, moved); h.commit(moved, []); assert.deepEqual(h.undo([]), moved);
  h.commit(moved, first); assert.equal(h.future.length, 0); assert.equal(h.commit(first, first), false);
});
test('正常レコードを受理し、欠落・NaN・範囲外・色・型を拒否する', () => {
  const raw = fixture(); assert.equal(validateRecords(raw).warnings.length, 0);
  for (const patch of [{ width: NaN }, { height: Infinity }, { width: -1 }, { background: undefined }, { strokes: null }, { items: {} }, { bookmarked: 'yes' }, { text: null }, { template: 'unknown' }, { template: ['grid'] }]) assert.equal(validPage({ ...raw.pages[0], ...patch }), false, JSON.stringify(patch));
  for (const patch of [{ size: 0 }, { color: 'red' }, { tool: 'eraser' }, { points: [[1, 2, 3]] }, { points: [[-1, 0, .5]] }, { points: [[1, Infinity, .5]] }, { points: [] }]) assert.equal(validStroke(stroke([[1, 1, .5]], patch), 100, 100), false);
  assert.equal(validFile({ id: 'f', name: 'x', mime: 'image/jpeg', blob: new Blob(['image'], { type: 'image/jpeg' }) }), true);
  assert.equal(validFile({ id: 'f', name: 'x', mime: 'image/jpeg', blob: new Blob([]) }), false);
});
test('欠落フィールド・不正folder・notebook・重複IDを拒否する', () => {
  const raw = fixture(); raw.notebooks[0].coverColor = '#fff'; assert.equal(validateRecords(raw).notebooks.length, 0);
  const raw2 = fixture(); delete raw2.notebooks[0].createdAt; assert.equal(validateRecords(raw2).notebooks.length, 0);
  const raw3 = fixture(); raw3.notebooks[0].pageIds.push(raw3.pages[0].id); assert.equal(validateRecords(raw3).notebooks.length, 0);
  const raw4 = fixture(); raw4.folders.push({ id: 'f', name: '', order: -1, createdAt: 0, updatedAt: 0 }); assert.equal(validateRecords(raw4).folders.length, 0);
});
test('参照切れを拒否して元データを削除しない', () => {
  for (const modify of [r => { r.notebooks[0].folderId = 'missing'; }, r => { r.notebooks[0].pageIds.push('missing'); }, r => { r.pages[0].notebookId = 'missing'; }, r => { r.pages[0].background = { type: 'pdf', fileId: 'missing', pageIndex: 0 }; }]) {
    const raw = fixture(); modify(raw); const before = structuredClone(raw), result = validateRecords(raw); assert.equal(result.notebooks.length, 0); assert.equal(result.pages.length, 0); assert.ok(result.warnings.length); assert.deepEqual(raw, before);
  }
});
test('背景のファイル種類、PDFページ番号、項目の参照を検証する', () => {
  const raw = fixture(); raw.files.push({ id: 'file1', mime: 'application/pdf', name: 'a.pdf', blob: new Blob(['pdf'], { type: 'application/pdf' }) }); raw.pages[0].background = { type: 'pdf', fileId: 'file1', pageIndex: 0 }; assert.equal(validateRecords(raw).warnings.length, 0);
  raw.pages[0].background.type = 'image'; assert.equal(validateRecords(raw).pages.length, 0);
  raw.pages[0].background = null; raw.pages[0].items = [{ id: 'item', type: 'image', fileId: 'missing', x: 0, y: 0, width: 10, height: 10 }]; assert.equal(validateRecords(raw).pages.length, 0);
});
