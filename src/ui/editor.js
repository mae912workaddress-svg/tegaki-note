import { el, button, option, dialog, field } from './dom.js';
import { addPage, removePage, duplicatePage, reorderPages, uid } from '../model/notebooks.js';
import { History } from '../model/history.js';
import { eraseAt, selectStrokes, strokeHit } from '../model/geometry.js';
import { Autosave } from '../storage/autosave.js';
import { configureCanvas, clearCanvas, drawStroke, renderPage, releaseCanvas, textLines } from '../render/page.js';
import { pointerPressure, appendStrokePoint } from '../render/strokes.js';
import { pageAssets } from '../render/assets.js';
import { prepareImage } from '../import/images.js';
import { itemWidth,itemHeight,fitImage } from '../model/images.js';
import { pageContent,itemHit,selectItems,moveContent } from '../model/items.js';
import { exportDialog } from './export.js';
import { pagePanel } from './pages.js';

const COLORS = ['#263238', '#c0392b', '#d78b27', '#e2bf33', '#368060', '#386fb4', '#8056ad', '#d37898'];
export function mountEditor(root, repository, initialNotebook, initialPages, { back, report, initialPageId, editing }) {
  let notebook = initialNotebook, pages = new Map(initialPages.map(p => [p.id, p]));
  let scale = 1, current = 0, tool = 'pen', previousTool = 'pen', color = COLORS[0], size = 2, eraserMode = 'whole', fingerDraw = false;
  let active = null, selected = { pageId: null, ids: [] }, pinch = null, gesture = null, frame = 0, scrollFrame = 0, disposed = false, busy = false;
  const mounted = new Map(), shells = new Map(), histories = new Map(), controller = new AbortController();
  const retainedFiles = editing || repository.retainEditingFiles?.();
  const listen = (target, name, fn, options = {}) => target.addEventListener(name, fn, { ...options, signal: controller.signal });
  const history = id => { if (!histories.has(id)) histories.set(id, new History()); return histories.get(id); };
  const status = el('span', { className: 'save-status', role: 'status' }, '保存済み');
  const autosave = new Autosave(repository, (message, error) => { status.textContent = message; status.classList.toggle('error', Boolean(error)); });
  const title = el('h1', { className: 'editor-title' }, notebook.name);
  const scroller = el('div', { className: 'page-scroller', tabindex: '0', 'aria-label': 'ノートのページ' });
  const stack = el('div', { className: 'page-stack' }); scroller.append(stack);
  const indicator = el('div', { className: 'page-indicator' });
  const safeRun = action => async () => { if (busy) return; try { await action(); } catch (error) { report(error.message); } };
  const setBusy = value => { busy = value; root.setAttribute('aria-busy', String(value)); };
  async function structural(action) {
    finishInput(true); setBusy(true);
    try { await autosave.flush(); await action(); } finally { setBusy(false); }
  }
  const header = el('header', { className: 'editor-header' }, button('‹ 一覧', safeRun(() => structural(back))), title, status, button('再保存', safeRun(() => autosave.flush())));
  header.append(button('書き出し',safeRun(()=>structural(()=>exportDialog(notebook,[...pages.values()],repository,report,notebook.pageIds[current])))));
  const toolbar = el('div', { className: 'toolbar', 'aria-label': '描画ツール' });
  const toolButtons = new Map();
  const tools = el('div', { className: 'tool-group' });
  for (const [value, label] of [['pen', 'ペン'], ['highlighter', '蛍光ペン'], ['eraser', '消しゴム'], ['lasso', '投げなわ'],['select','選択'],['text','テキスト']]) {
    const b = button(label, () => chooseTool(value)); toolButtons.set(value, b); tools.append(b);
  }
  const colorGroup = el('div', { className: 'tool-group color-group', 'aria-label': 'インクの色' });
  const colorButtons = COLORS.map((c, i) => {
    const b = button('', () => { color = c; updateToolbar(); }, 'color-choice'); b.style.backgroundColor = c;
    b.setAttribute('aria-label', ['黒', '赤', '橙', '黄', '緑', '青', '紫', '桃'][i]); colorGroup.append(b); return b;
  });
  const sizes = el('select', { 'aria-label': 'ペンの太さ' }, ...[1, 2, 4, 7, 12].map(n => option(n, `${n} pt`))); sizes.value = String(size);
  listen(sizes, 'change', () => { size = Number(sizes.value); });
  const eraseMode = el('select', { 'aria-label': '消しゴム方式' }, option('whole', '線ごと消す'), option('partial', '部分を消す'));
  listen(eraseMode, 'change', () => { eraserMode = eraseMode.value; });
  const undo = button('↶ 戻す', () => historyAction('undo')), redo = button('↷ やり直す', () => historyAction('redo'));
  const deleteSelected = button('選択を削除', () => {
    if (active || busy || !selected.ids.length) return;
    const page = pages.get(selected.pageId), before = pageContent(page);
    page.strokes = page.strokes.filter(s => !selected.ids.includes(s.id)); page.items=page.items.filter(i=>!selected.ids.includes(i.id)); commit(page, before); selected = { pageId: null, ids: [] }; redraw(page.id); updateToolbar();
  });
  const addPosition = el('select', { 'aria-label': 'ページ追加位置' }, option('after', '現在の後ろ'), option('end', '末尾'));
  const append = button('＋ ページ', safeRun(() => structural(async () => {
    const result = addPage(notebook, [...pages.values()], addPosition.value === 'after' ? notebook.pageIds[current] : null);
    await repository.saveNotebook(result.notebook, [result.page]);
    notebook = result.notebook; pages.set(result.page.id, result.page); current = notebook.pageIds.indexOf(result.page.id);
    buildShells(); jumpToCurrent();
  })));
  const deletePage = button('ページ削除', safeRun(async () => {
    if (notebook.pageIds.length <= 1) { report('最後の1ページは削除できません。消しゴムで内容を消せます。'); return; }
    const id = notebook.pageIds[current];
    if (!confirm(`${current + 1}ページ目を削除しますか？この操作は取り消せません。`)) return;
    await structural(async () => {
      const result = removePage(notebook, [...pages.values()], id);
      await repository.saveNotebook(result.notebook, [], [id]); notebook = result.notebook; pages.delete(id); histories.delete(id);
      current = Math.min(current, notebook.pageIds.length - 1); selected = { pageId: null, ids: [] }; buildShells(); jumpToCurrent();
    });
  }));
  const finger = el('input', { type: 'checkbox' });
  listen(finger, 'change', () => { finishInput(true); fingerDraw = finger.checked; for (const shell of shells.values()) shell.classList.toggle('finger-draw', fingerDraw); });
  const zoomText = el('span', { className: 'zoom-value' });
  const zoomOut = button('−', () => setScale(scale / 1.2)), zoomIn = button('＋', () => setScale(scale * 1.2));
  zoomOut.setAttribute('aria-label', '縮小'); zoomIn.setAttribute('aria-label', '拡大');
  const help=el('span',{className:'selection-help'});
  const imagePicker=el('input',{type:'file',accept:'image/jpeg,image/png',hidden:true});
  listen(imagePicker,'change',safeRun(async()=>{
    const file=imagePicker.files[0]; imagePicker.value='';if(!file)return;
    await structural(async()=>{
      const page=pages.get(notebook.pageIds[current]),before=pageContent(page),image=await prepareImage(file,true);
      const box=fitImage(image.width,image.height,page.width*.6,page.height*.6);
      const item={id:uid(),type:'image',fileId:image.id,x:(page.width-box.w)/2,y:(page.height-box.h)/2,w:box.w,h:box.h};
      const next={...page,items:[...page.items,item]};await repository.savePageWithFile(next,image);
      page.items=next.items;commit(page,before);selected={pageId:page.id,ids:[item.id]}; refreshAssets(page.id);updateToolbar();
    });
    chooseTool('select');
  }));
  const imageButton=button('画像',()=>imagePicker.click());
  const editItem=button('項目を編集',safeRun(async()=>{
    const page=pages.get(selected.pageId),item=page?.items.find(i=>selected.ids.includes(i.id));if(!item)return;
    if(item.type==='text')await editText(page,item);
  }));
  function resizeSelected(factor){
    if(busy||active)return;const page=pages.get(selected.pageId);if(!page)return;const before=pageContent(page);
    page.items=page.items.map(i=>{
      if(i.type!=='image'||!selected.ids.includes(i.id))return i;
      const ratio=Math.max(1/itemWidth(i),1/itemHeight(i),Math.min(factor,(page.width-i.x)/itemWidth(i),(page.height-i.y)/itemHeight(i)));
      return {...i,w:itemWidth(i)*ratio,h:itemHeight(i)*ratio};
    });commit(page,before);redraw(page.id);
  }
  const bookmark=button('☆ しおり',()=>{if(busy||active)return;const page=pages.get(notebook.pageIds[current]);page.bookmarked=!page.bookmarked;autosave.mark(page);updateToolbar();});
  const panel=button('ページ一覧',safeRun(async()=>{
    finishInput(true);await autosave.flush();
    await pagePanel(()=>({notebook,pages:[...pages.values()]}),repository,{
      jump:id=>{current=notebook.pageIds.indexOf(id);jumpToCurrent();},
      reorder:(id,target)=>structural(async()=>{const ids=[...notebook.pageIds],to=ids.indexOf(target);ids.splice(ids.indexOf(id),1);ids.splice(to,0,id);const next=reorderPages(notebook,ids);await repository.saveNotebook(next,[]);notebook=next;current=ids.indexOf(id);buildShells();jumpToCurrent();}),
      step:(id,delta)=>structural(async()=>{const ids=[...notebook.pageIds],from=ids.indexOf(id),to=from+delta;if(to<0||to>=ids.length)return;[ids[from],ids[to]]=[ids[to],ids[from]];const next=reorderPages(notebook,ids);await repository.saveNotebook(next,[]);notebook=next;current=to;buildShells();jumpToCurrent();}),
      duplicate:id=>structural(async()=>{const result=duplicatePage(notebook,[...pages.values()],id);await repository.saveNotebook(result.notebook,[result.page]);notebook=result.notebook;pages.set(result.page.id,result.page);current=notebook.pageIds.indexOf(result.page.id);buildShells();jumpToCurrent();}),
      remove:id=>structural(async()=>{if(!confirm('このページを削除しますか？この操作は取り消せません。'))return;const result=removePage(notebook,[...pages.values()],id);await repository.saveNotebook(result.notebook,[],[id]);notebook=result.notebook;pages.delete(id);histories.delete(id);selected={pageId:null,ids:[]};current=Math.min(current,notebook.pageIds.length-1);buildShells();jumpToCurrent();})
    },report);
  }));
  toolbar.append(tools,imageButton,imagePicker,colorGroup, el('div', { className: 'tool-group' }, sizes, eraseMode), el('div', { className: 'tool-group' }, undo, redo, deleteSelected,editItem,button('画像＋',()=>resizeSelected(1.15)),button('画像−',()=>resizeSelected(1/1.15))), el('div', { className: 'tool-group' }, addPosition, append, deletePage,panel,bookmark), el('div', { className: 'tool-group' }, zoomOut, zoomText, zoomIn), el('label', { className: 'finger-setting' }, finger, '指でも描く'),help);
  const toggle = button('消しゴムに切替', () => chooseTool(tool === 'eraser' ? previousTool : 'eraser'), 'eraser-toggle');
  root.replaceChildren(el('section', { className: 'editor' }, header, toolbar, el('div', { className: 'editor-workspace' }, scroller, indicator), toggle));

  function chooseTool(next) {
    if (busy) return; finishInput(true);
    if (next === 'eraser' && tool !== 'eraser') previousTool = tool;
    tool = next;
    if (!['lasso','select'].includes(tool)) { const old = selected.pageId; selected = { pageId: null, ids: [] }; if (old) redraw(old); }
    for(const shell of shells.values())shell.classList.toggle('item-mode',['select','text'].includes(tool));
    updateToolbar();
  }
  function updateToolbar() {
    for (const [value, b] of toolButtons) b.setAttribute('aria-pressed', String(tool === value));
    colorButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(COLORS[i] === color)));
    const h = history(notebook.pageIds[current]); undo.disabled = !h.past.length; redo.disabled = !h.future.length;
    deleteSelected.disabled = !selected.ids.length; eraseMode.disabled = tool !== 'eraser';
    const selectedItem=pages.get(selected.pageId)?.items.find(i=>selected.ids.includes(i.id));editItem.disabled=selectedItem?.type!=='text';
    bookmark.textContent=pages.get(notebook.pageIds[current])?.bookmarked?'★ しおり':'☆ しおり';
    help.textContent={pen:'ペン：Pencilで描画。指でスクロール・拡大縮小',highlighter:'蛍光ペン：透過色でマーク',eraser:'消しゴム：線ごと／部分を消す',lasso:'投げなわ：線・画像・文字を囲んで移動',select:'選択：画像・文字をタップしてドラッグ。画像＋−でサイズ変更',text:'テキスト：用紙をタップして入力'}[tool];
    toggle.textContent = tool === 'eraser' ? '前のツールに戻る' : '消しゴムに切替'; toggle.setAttribute('aria-pressed', String(tool === 'eraser'));
    indicator.textContent = `${current + 1} / ${notebook.pageIds.length} ページ`; zoomText.textContent = `${Math.round(scale * 100)}%`;
    for (const [id, shell] of shells) shell.classList.toggle('active-page', id === notebook.pageIds[current]);
  }
  function redraw(id) {
    const layer = mounted.get(id), page = pages.get(id);
    if (layer && page) renderPage(layer.baseContext, page, selected.pageId === id ? selected.ids : [],layer.assets);
  }
  function refreshAssets(id){
    const layer=mounted.get(id),page=pages.get(id);if(!layer||!page)return;
    const version=layer.version=(layer.version||0)+1; const snapshot=structuredClone(page),ratio=layer.base.width/page.width;
    layer.loading?.abort();layer.loading=new AbortController();
    pageAssets(snapshot,fileId=>repository.getFile(fileId),ratio,layer.loading.signal).then(assets=>{
      if(disposed||mounted.get(id)!==layer||layer.version!==version){assets.release();return;}
      layer.assets?.release();layer.assets=assets;redraw(id);
    }).catch(error=>{if(!disposed&&mounted.get(id)===layer&&layer.version===version)report(error.message);});
  }
  function unmount(id) {
    const layer = mounted.get(id); if (!layer) return;
    layer.loading?.abort();layer.assets?.release();releaseCanvas(layer.base); releaseCanvas(layer.live); mounted.delete(id);
  }
  function mount(id) {
    if (mounted.has(id)) return;
    const shell = shells.get(id), page = pages.get(id), base = el('canvas'), live = el('canvas');
    const baseContext = configureCanvas(base, page, scale), liveContext = configureCanvas(live, page, scale);
    shell.append(base, live); mounted.set(id, { base, live, baseContext, liveContext }); redraw(id);refreshAssets(id);
  }
  function buildShells() {
    const target = current;
    for (const id of [...mounted.keys()]) unmount(id);
    shells.clear(); stack.replaceChildren();
    for (const [index, id] of notebook.pageIds.entries()) {
      const shell = el('div', { className: `page-shell${fingerDraw ? ' finger-draw' : ''}${['select','text'].includes(tool)?' item-mode':''}`, 'data-page': id, 'aria-label': `${index + 1}ページ` }, el('span', { className: 'page-label' }, `${index + 1}`));
      shells.set(id, shell); stack.append(shell);
    }
    layout(); updateViewport(); current = target; updateToolbar();
  }
  function layout() {
    let width = 0;
    for (const [id, shell] of shells) { const p = pages.get(id); shell.style.width = `${p.width * scale}px`; shell.style.height = `${p.height * scale}px`; width = Math.max(width, p.width * scale); }
    stack.style.width = `${width}px`;
    for (const [id, layer] of mounted) {
      layer.baseContext = configureCanvas(layer.base, pages.get(id), scale); layer.liveContext = configureCanvas(layer.live, pages.get(id), scale); redraw(id);refreshAssets(id);
    }
    updateToolbar();
  }
  function updateViewport() {
    if (disposed) return;
    const bounds = scroller.getBoundingClientRect(), center = bounds.top + Math.min(bounds.height / 2, 250);
    let nearest = 0, distance = Infinity;
    for (const [index, id] of notebook.pageIds.entries()) {
      const rect = shells.get(id).getBoundingClientRect();
      const d = center < rect.top ? rect.top - center : center > rect.bottom ? center - rect.bottom : 0;
      if (d < distance) { nearest = index; distance = d; }
    }
    if (!active) current = nearest;
    const keep = new Set(notebook.pageIds.slice(Math.max(0, nearest - 2), nearest + 3));
    if (active) keep.add(active.pageId);
    for (const id of [...mounted.keys()]) if (!keep.has(id)) unmount(id);
    for (const id of keep) mount(id);
    updateToolbar();
  }
  function jumpToCurrent() { const shell = shells.get(notebook.pageIds[current]); scroller.scrollTop = shell.offsetTop - 24; updateViewport(); }
  function setScale(next, clientX, clientY) {
    if (busy || active?.type === 'pen') return;
    next = Math.max(.5, Math.min(4, next)); if (Math.abs(next - scale) < .002) return;
    const bounds = scroller.getBoundingClientRect(), x = clientX == null ? bounds.width / 2 : clientX - bounds.left, y = clientY == null ? bounds.height / 2 : clientY - bounds.top;
    // Anchor the same page point under the pinch midpoint despite fixed page gaps.
    let anchor = notebook.pageIds[current];
    for (const id of notebook.pageIds) { const rect = shells.get(id).getBoundingClientRect(); if (bounds.top + y >= rect.top && bounds.top + y <= rect.bottom) { anchor = id; break; } }
    const shell = shells.get(anchor), rect = shell.getBoundingClientRect();
    const px = (bounds.left + x - rect.left) / scale, py = (bounds.top + y - rect.top) / scale;
    scale = next; layout();
    const after = shell.getBoundingClientRect();
    scroller.scrollLeft += after.left + px * scale - bounds.left - x;
    scroller.scrollTop += after.top + py * scale - bounds.top - y;
    updateViewport();
  }
  function coordinates(event, id) {
    const p = pages.get(id), rect = shells.get(id).getBoundingClientRect();
    return [Math.max(0, Math.min(p.width, (event.clientX - rect.left) / scale)), Math.max(0, Math.min(p.height, (event.clientY - rect.top) / scale)), pointerPressure(event)];
  }
  function commit(page, before) {
    if (history(page.id).commit(before, pageContent(page))) autosave.mark(page); updateToolbar();
  }
  async function editText(page,item,point=[page.width/4,page.height/4]) {
    finishInput(true);setBusy(true);
    try {
      const result=await dialog(item?'テキストを編集':'テキストを追加',finish=>{
        const input=el('textarea',{rows:6,maxlength:2000,autofocus:true,'aria-label':'テキスト'},item?.text||'');
        const font=el('select',{},...[[14,'小'],[22,'中'],[32,'大']].map(([v,label])=>option(v,label)));font.value=String(item?.fontSize||22);
        const ink=el('input',{type:'color',value:item?.color||color});
        return el('div',{},field('文字',input),field('文字サイズ',font),field('色',ink),el('div',{className:'actions'},button('キャンセル',()=>finish(null)),button('保存',()=>{if(input.value.trim())finish({text:input.value,fontSize:Number(font.value),color:ink.value});},'primary')));
      });
      if(!result)return;
      const before=pageContent(page),w=item?itemWidth(item):Math.min(280,page.width*.8);
      const next={...(item||{id:uid(),type:'text',x:Math.min(point[0],page.width-w),y:point[1]}),...result,w};
      const canvas=document.createElement('canvas');next.h=textLines(canvas.getContext('2d'),next).length*next.fontSize*1.3;canvas.width=canvas.height=0;
      if(next.h>10000)throw new Error('文字が多すぎます。短いテキストに分けてください。');
      next.y=Math.max(0,Math.min(next.y,page.height-next.h));
      page.items=item?page.items.map(i=>i.id===item.id?next:i):[...page.items,next];
      commit(page,before);selected={pageId:page.id,ids:[next.id]};redraw(page.id);
    } finally {setBusy(false);chooseTool('select');updateToolbar();}
  }
  async function historyAction(action) {
    if (active || busy) return;
    setBusy(true);
    try {
      await retainedFiles?.ensure?.();
      if (disposed) return;
      const page = pages.get(notebook.pageIds[current]); Object.assign(page,history(page.id)[action](pageContent(page)));
      selected = { pageId: null, ids: [] }; autosave.mark(page); redraw(page.id);refreshAssets(page.id); updateToolbar();
    } catch (error) { report(error.message); }
    finally { setBusy(false); }
  }
  function schedulePaint() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; paintInput(); });
  }
  function paintInput() {
    if (!active) return;
    const layer = mounted.get(active.pageId); if (!layer) return;
    clearCanvas(layer.liveContext);
    if (active.mode === 'draw') drawStroke(layer.liveContext, active.stroke);
    else if (active.mode === 'lasso') {
      const ctx = layer.liveContext; ctx.save(); ctx.lineWidth = 1.3 / scale; ctx.strokeStyle = '#278be0'; ctx.fillStyle = '#278be012'; ctx.setLineDash([5 / scale, 3 / scale]); ctx.beginPath();
      active.points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    } else redraw(active.pageId);
  }
  function applyEraser(point) {
    const page = pages.get(active.pageId), radius = active.radius, previous = active.last || point;
    const distance = Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * .5)));
    for (let i = 1; i <= steps; i++) page.strokes = eraseAt(page.strokes, [previous[0] + (point[0] - previous[0]) * i / steps, previous[1] + (point[1] - previous[1]) * i / steps], radius, active.eraseMode);
    active.last = point;
  }
  function finishInput(commitInput) {
    if (!active) return;
    const a = active, page = pages.get(a.pageId); active = null;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    const layer = mounted.get(a.pageId); if (layer) clearCanvas(layer.liveContext);
    if (!commitInput) { Object.assign(page,a.before); }
    else if (a.mode === 'draw') { page.strokes = [...a.before.strokes, a.stroke]; commit(page, a.before); }
    else if (a.mode === 'lasso') { selected = { pageId: a.pageId, ids: [...selectStrokes(page.strokes, a.points),...selectItems(page.items,a.points)] }; }
    else commit(page, a.before);
    const shell = shells.get(a.pageId); if (shell?.hasPointerCapture(a.pointerId)) shell.releasePointerCapture(a.pointerId);
    redraw(a.pageId); updateToolbar();
  }
  listen(stack, 'pointerdown', event => {
    if (busy || active || pinch || event.button !== 0 || (event.pointerType === 'touch' && !fingerDraw && !['select','text'].includes(tool))) return;
    const shell = event.target.closest('.page-shell'); if (!shell) return;
    event.preventDefault();
    const id = shell.dataset.page, page = pages.get(id), point = coordinates(event, id); current = notebook.pageIds.indexOf(id); mount(id);
    if(tool==='text'){safeRun(()=>editText(page,null,point))();return;}
    const before = pageContent(page);
    let mode = tool === 'eraser' ? 'erase' : tool === 'lasso' ? 'lasso' : 'draw';
    if(tool==='select'){
      const item=[...page.items].reverse().find(i=>itemHit(i,point));selected={pageId:id,ids:item?[item.id]:[]};
      if(!item){redraw(id);updateToolbar();return;}mode='move';
    }
    if (tool === 'lasso' && selected.pageId === id && (page.strokes.some(s => selected.ids.includes(s.id) && strokeHit(s, point, 12 / scale)) || page.items.some(i=>selected.ids.includes(i.id)&&itemHit(i,point)))) mode = 'move';
    else if (tool === 'lasso') { const old = selected.pageId; selected = { pageId: null, ids: [] }; if (old) redraw(old); }
    active = { pageId: id, pointerId: event.pointerId, type: event.pointerType, before, mode, start: point, points: [point], radius: Math.max(6, size * 2), eraseMode: eraserMode, stroke: { id: uid(), tool, color, size: tool === 'highlighter' ? size * 5 : size, points: [point] } };
    shell.setPointerCapture(event.pointerId);
    if (mode === 'erase') applyEraser(point);
    schedulePaint(); updateToolbar();
  });
  function moveInput(event, terminal = false) {
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    for (const e of events.length ? events : [event]) {
      const point = coordinates(e, active.pageId), page = pages.get(active.pageId);
      if (active.mode === 'draw') appendStrokePoint(active.stroke.points, point, { terminal:terminal && active.type === 'pen' });
      else if (active.mode === 'lasso') active.points.push(point);
      else if (active.mode === 'erase') applyEraser(point);
      else Object.assign(page,moveContent(active.before,selected.ids,point[0]-active.start[0],point[1]-active.start[1],page.width,page.height));
    }
    schedulePaint();
  }
  listen(stack, 'pointermove', moveInput);
  listen(stack, 'pointerup', event => { if (active?.pointerId === event.pointerId) { moveInput(event, true); finishInput(true); } });
  listen(stack, 'pointercancel', event => { if (active?.pointerId === event.pointerId) finishInput(false); });
  listen(stack, 'lostpointercapture', event => { if (active?.pointerId === event.pointerId) finishInput(false); });
  const touches = event => [...event.touches].filter(t => t.touchType !== 'stylus');
  const metrics = list => ({ distance: Math.hypot(list[0].clientX - list[1].clientX, list[0].clientY - list[1].clientY), x: (list[0].clientX + list[1].clientX) / 2, y: (list[0].clientY + list[1].clientY) / 2 });
  function touchHandler(event) {
    // Pencil has a TouchEvent in Safari too; cancel native scrolling only for it.
    if ([...event.touches].some(t => t.touchType === 'stylus') || active?.type === 'pen') { event.preventDefault(); return; }
    const fingers = touches(event);
    if (fingers.length >= 2) {
      event.preventDefault(); finishInput(false); const m = metrics(fingers);
      if (!pinch) pinch = { ...m, scale };
      else if (pinch.distance > 0) setScale(pinch.scale * m.distance / pinch.distance, m.x, m.y);
    } else if (fingerDraw || ['select','text'].includes(tool)) event.preventDefault();
  }
  listen(scroller, 'touchstart', touchHandler, { passive: false });
  listen(scroller, 'touchmove', touchHandler, { passive: false });
  let lastTap = 0;
  listen(scroller, 'touchend', event => { if (touches(event).length < 2) pinch = null; const now = Date.now(); if (now - lastTap < 300) event.preventDefault(); lastTap = now; }, { passive: false });
  listen(scroller, 'touchcancel', () => { pinch = null; finishInput(false); });
  listen(scroller, 'gesturestart', event => { event.preventDefault(); if (!pinch && !active) gesture = { scale }; }, { passive: false });
  listen(scroller, 'gesturechange', event => { event.preventDefault(); if (gesture && !pinch) setScale(gesture.scale * event.scale, event.clientX, event.clientY); }, { passive: false });
  listen(scroller, 'gestureend', event => { event.preventDefault(); gesture = null; }, { passive: false });
  listen(scroller, 'dblclick', event => event.preventDefault());
  listen(scroller, 'contextmenu', event => event.preventDefault());
  listen(scroller, 'scroll', () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; updateViewport(); }); }, { passive: true });
  const flushOnHide = () => { finishInput(true); autosave.flush().catch(() => {}); };
  retainedFiles?.setRecoveryHandler?.(async () => {
    const available = await repository.existingFileIds();
    let removed = 0;
    for (const h of histories.values()) removed += h.removeMissingFiles(available);
    if (removed && !disposed) {
      updateToolbar(); report('バックグラウンド中に一部の取り消し履歴が使えなくなりました');
    }
  });
  const resume = async () => {
    try { await retainedFiles?.ensure?.(); } catch (error) { if (!disposed) report(error.message); }
  };
  listen(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') flushOnHide(); else if (document.visibilityState === 'visible') return resume(); });
  listen(window, 'pageshow', event => { if (event.persisted) return resume(); });
  listen(window, 'focus', resume);
  listen(window, 'pagehide', flushOnHide);
  listen(window, 'resize', () => { finishInput(true); layout(); updateViewport(); });
  listen(window, 'keydown', event => {
    if (event.target.matches('input,select,textarea')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); historyAction(event.shiftKey ? 'redo' : 'undo'); }
  });
  const first = pages.get(notebook.pageIds[0]); scale = Math.max(.5, Math.min(1.2, (scroller.clientWidth - 48) / first.width));
  buildShells();
  if(initialPageId&&notebook.pageIds.includes(initialPageId)){current=notebook.pageIds.indexOf(initialPageId);jumpToCurrent();}
  const dispose = () => {
    disposed = true; controller.abort(); clearTimeout(autosave.timer); cancelAnimationFrame(frame); cancelAnimationFrame(scrollFrame);
    for (const id of [...mounted.keys()]) unmount(id);
  };
  return () => {
    if (!retainedFiles) return dispose();
    finishInput(true);
    // A failed flush/collection keeps the editor and its Undo lock usable for retry.
    return autosave.flush().then(() => retainedFiles.release()).then(dispose);
  };
}
