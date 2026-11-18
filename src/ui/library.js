import { el, button, field, option, dialog, nameDialog } from './dom.js';
import { TEMPLATES } from '../model/templates.js';
import { createNotebook, duplicateNotebook, uid } from '../model/notebooks.js';
import { importFiles } from '../import/notebooks.js';
import { searchNotes } from '../model/search.js';
import { createBackup,backupName } from '../storage/backup.js';
import { exportDialog,preparedShareDialog } from './export.js';
import { rasterizePage } from '../export/raster.js';
export const COVER_COLORS = ['#52796f', '#5e7caa', '#bd8268', '#bc9b50', '#967ca2', '#697580'];
export async function newNotebookDialog(folderId) {
  return dialog('新しいノート', finish => {
    const name = el('input', { placeholder: '新しいノート', maxlength: 100, autofocus: true });
    const template = el('select', {}, ...Object.entries(TEMPLATES).map(([value, label]) => option(value, label)));
    const orientation = el('select', {}, option('portrait', 'A4 縦'), option('landscape', 'A4 横'));
    const cover = el('select', { 'aria-label': '表紙色' }, ...COVER_COLORS.map((c, i) => option(c, ['緑', '青', 'テラコッタ', '黄', '紫', 'グレー'][i])));
    const save = button('作成', () => { if (name.reportValidity()) finish(createNotebook({ name: name.value, template: template.value, orientation: orientation.value, coverColor: cover.value, folderId })); }, 'primary');
    const content = el('div', {}, field('ノート名', name), field('用紙', template), field('向き', orientation), field('表紙色', cover), el('div', { className: 'actions' }, button('キャンセル', () => finish(null)), save));
    content.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } }); return content;
  });
}
export function mountLibrary(root, repository, data, { openNotebook, reload, report }) {
  let folder = 'all', sort = 'updated', query = '', disposed = false;
  let importing = false, previewQueue = Promise.resolve();
  const run = action => async () => { try { await action(); } catch (error) { report(error.message); } };
  const count = el('p', { className: 'eyebrow' }, 'あなたの考えを、一冊ずつ。');
  const header = el('header', { className: 'library-header' }, el('div', {}, count, el('h1', {}, 'てがきノート')), button('＋ 新しいノート', run(async () => {
    const result = await newNotebookDialog(folder === 'all' || folder === 'none' ? null : folder);
    if (result) { await repository.saveNotebook(result.notebook, result.pages); await openNotebook(result.notebook.id); }
  }), 'primary'));
  const picker=el('input',{type:'file',accept:'application/pdf,image/jpeg',multiple:true,hidden:true});
  const restorePicker=el('input',{type:'file',accept:'application/json,.json',hidden:true});
  const importStatus=el('p',{role:'status'});
  async function readFiles(files) {
    if(importing || !files.length) return; importing=true; importStatus.textContent='読み込み中…';
    try {
      const records=await importFiles(files,folder==='all'||folder==='none'?null:folder);
      await repository.importRecords(records); await openNotebook(records.notebooks[0].id);
    } finally { importing=false; importStatus.textContent='';picker.value=''; }
  }
  picker.addEventListener('change',run(()=>readFiles([...picker.files])));
  restorePicker.addEventListener('change',run(async()=>{
    const file=restorePicker.files[0]; restorePicker.value=''; if(!file)return;
    const backup=await file.text();
    if(confirm('現在のノートはすべて置き換えられます。復元しますか？')) { await repository.restoreBackup(backup); await reload(); }
  }));
  header.append(button('読み込み',()=>picker.click()),button('…',run(async()=>{
    const action=await dialog('データ管理',finish=>el('div',{className:'menu-actions'},button('バックアップ',()=>finish('backup')),button('復元',()=>finish('restore')),button('閉じる',()=>finish(null))));
    if(action==='restore')restorePicker.click();
    if(action==='backup') {
      const records=await repository.load(); if(records.warnings.length)throw new Error('保存データに問題があるためバックアップを中止しました。');
      const backup=await createBackup(records); await preparedShareDialog(new File([JSON.stringify(backup)],backupName(),{type:'application/json'}),report);
    }
  })),picker,restorePicker);
  const search = el('input', { type: 'search', placeholder: 'ノート名・文字・PDFを検索', 'aria-label': 'ノート名・文字・PDFを検索' });
  const order = el('select', { 'aria-label': '並び替え' }, option('updated', '更新日順'), option('name', '名前順'));
  const tabs = el('div', { className: 'folder-tabs', 'aria-label': 'フォルダ' });
  const grid = el('div', { className: 'notebook-grid' });
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target);
      const page = data.pages.find(p => p.id === entry.target.dataset.page);
      if (!page || disposed) continue;
      previewQueue=previewQueue.then(async()=>{
        if(disposed || !entry.target.isConnected)return;
        const blob=await rasterizePage(page,id=>repository.getFile(id),18);
        if(disposed || !entry.target.isConnected)return;
        const url=URL.createObjectURL(blob), image=el('img',{src:url,alt:'',loading:'lazy'});
        image.onload=image.onerror=()=>URL.revokeObjectURL(url); entry.target.append(image);
      }).catch(error=>{ if(!disposed) report(error.message); });
    }
  }, { rootMargin: '150px' });
  function renderTabs() {
    tabs.replaceChildren(...[['all', 'すべて'], ['none', '未分類'], ...data.folders.sort((a, b) => a.order - b.order).map(f => [f.id, f.name])].map(([id, name]) => {
      const b = button(name, () => { folder = id; renderTabs(); renderGrid(); }, 'folder-tab'); b.setAttribute('aria-pressed', String(folder === id)); return b;
    }));
    tabs.append(button('＋ フォルダ', run(async () => { const name = await nameDialog('フォルダを作成'); if (name) { const now = Date.now(); await repository.saveFolder({ id: uid(), name, order: data.folders.length, createdAt: now, updatedAt: now }); await reload(); } })));
    if (folder !== 'all' && folder !== 'none') tabs.append(button('フォルダ設定', run(async () => {
      const target = data.folders.find(f => f.id === folder);
      const action = await dialog('フォルダ設定', finish => el('div', { className: 'menu-actions' }, button('名前を変更', () => finish('rename')), button('フォルダを削除', () => finish('delete'), 'danger'), button('閉じる', () => finish(null))));
      if (action === 'rename') { const name = await nameDialog('フォルダ名を変更', target.name); if (name) await repository.saveFolder({ ...target, name, updatedAt: Date.now() }); }
      if (action === 'delete' && confirm(`「${target.name}」を削除しますか？中のノートは削除せず「未分類」へ移動します。`)) await repository.deleteFolder(target.id);
      await reload();
    })));
  }
  async function notebookMenu(notebook) {
    const action = await dialog(notebook.name, finish => el('div', { className: 'menu-actions' }, ...[['export','書き出し'],['rename', '名前を変更'], ['duplicate', '複製'], ['move', 'フォルダへ移動'], ['color', '表紙色を変更'], ['delete', 'ノートを削除']].map(([key, label]) => button(label, () => finish(key), key === 'delete' ? 'danger' : '')), button('閉じる', () => finish(null))));
    if (!action) return;
    if(action==='export') { await exportDialog(notebook,data.pages,repository,report); return; }
    if (action === 'rename') {
      const name = await nameDialog('ノート名を変更', notebook.name);
      if (name) await repository.saveNotebook({ ...notebook, name, updatedAt: Date.now() }, []);
    } else if (action === 'duplicate') {
      const copy = duplicateNotebook(notebook, data.pages); await repository.saveNotebook(copy.notebook, copy.pages);
    } else if (action === 'delete') {
      if (confirm(`「${notebook.name}」と全ページを削除しますか？この操作は取り消せません。`)) await repository.deleteNotebook(notebook);
    } else {
      const value = await dialog(action === 'move' ? '移動先フォルダ' : '表紙色を変更', finish => {
        const select = el('select', {}, ...(action === 'move' ? [option('', '未分類'), ...data.folders.map(f => option(f.id, f.name))] : COVER_COLORS.map((c, i) => option(c, ['緑', '青', 'テラコッタ', '黄', '紫', 'グレー'][i]))));
        select.value = action === 'move' ? notebook.folderId || '' : notebook.coverColor;
        return el('div', {}, field(action === 'move' ? 'フォルダ' : '色', select), el('div', { className: 'actions' }, button('キャンセル', () => finish(null)), button(action === 'move' ? '移動' : '変更', () => finish(select.value), 'primary')));
      });
      if (value !== null) await repository.saveNotebook({ ...notebook, ...(action === 'move' ? { folderId: value || null } : { coverColor: value }), updatedAt: Date.now() }, []);
    }
    await reload();
  }
  function renderGrid() {
    observer.disconnect();
    const notebooks = data.notebooks.filter(n => (folder === 'all' || (folder === 'none' ? n.folderId === null : n.folderId === folder))).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'ja') : b.updatedAt - a.updatedAt);
    grid.replaceChildren();
    if(query.trim()) {
      const results=searchNotes(notebooks,data.pages,query);
      for(const result of results) { const b=button('',run(()=>openNotebook(result.notebookId,result.pageId)),'search-result'); b.append(el('strong',{},`${result.name} · ${result.pageNumber}ページ`),el('p',{},result.snippet)); grid.append(b); }
      if(!results.length)grid.append(el('p',{},'一致する文字が見つかりません。手書き文字は検索対象外です。')); return;
    }
    if (!notebooks.length) grid.append(el('div', { className: 'empty-state' }, el('span', { className: 'empty-mark', 'aria-hidden': 'true' }, '▤'), el('h2', {}, query ? 'ノートが見つかりません' : 'まっさらな一冊から。'), el('p', {}, query ? '別の名前で検索してください。' : '「新しいノート」で用紙を選んで、書きはじめましょう。')));
    for (const n of notebooks) {
      const preview = el('div', { className: 'notebook-preview', 'data-page': n.pageIds[0] }); preview.style.borderLeftColor = n.coverColor;
      const open = button('', run(() => openNotebook(n.id)), 'notebook-open'); open.append(preview, el('h2', {}, n.name), el('p', {}, `${n.pageIds.length}ページ · ${new Date(n.updatedAt).toLocaleDateString('ja-JP')}`));
      const menu = button('…', run(() => notebookMenu(n)), 'more-button'); menu.setAttribute('aria-label', `${n.name} のメニュー`);
      grid.append(el('article', { className: 'notebook-card' }, open, menu)); observer.observe(preview);
    }
  }
  search.addEventListener('input', () => { query = search.value; renderGrid(); });
  order.addEventListener('change', () => { sort = order.value; renderGrid(); });
  const section=el('section', { className: 'library' }, header, tabs, el('div', { className: 'library-controls' }, search, order),importStatus,el('details',{className:'import-help'},el('summary',{},'メールから読み込むには'),el('p',{},'メールで添付を開く → 共有 →「ファイルに保存」→ 読み込み。Split Viewでは、PDF・JPGの添付をこの一覧にドラッグ＆ドロップできます。')), grid, el('footer', {}, 'この端末に保存 · オフラインでも使えます'));
  section.addEventListener('dragover',event=>{event.preventDefault();});
  section.addEventListener('drop',event=>{event.preventDefault();run(()=>readFiles([...event.dataTransfer.files]))();});
  root.replaceChildren(section);
  renderTabs(); renderGrid();
  return () => { disposed = true; observer.disconnect(); };
}
