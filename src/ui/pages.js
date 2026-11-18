import { el,button,dialog } from './dom.js';
import { rasterizePage } from '../export/raster.js';
export async function pagePanel(getState,repository,actions,report) {
  let observer,closed=false,queue=Promise.resolve(),busy=false; const urls=new Set();
  try {
    await dialog('ページ一覧',finish=>{
      const only=el('input',{type:'checkbox'}), list=el('div',{className:'page-panel-list'});
      const run=fn=>async()=>{if(busy)return;busy=true;try{await fn();render();}catch(e){report(e.message);}finally{busy=false;}};
      observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){
        observer.unobserve(entry.target); const {pages}=getState(), page=pages.find(p=>p.id===entry.target.dataset.page);
        queue=queue.then(async()=>{
          if(closed||!entry.target.isConnected)return;
          const blob=await rasterizePage(page,id=>repository.getFile(id),16);
          if(closed||!entry.target.isConnected)return;
          const url=URL.createObjectURL(blob);urls.add(url);entry.target.append(el('img',{src:url,alt:''}));
        }).catch(e=>{if(!closed)report(e.message);});
      }},{root:list,rootMargin:'120px'});
      function render(){
        observer.disconnect();for(const url of urls)URL.revokeObjectURL(url);urls.clear();list.replaceChildren();
        const {notebook,pages}=getState();
        for(const [index,id] of notebook.pageIds.entries()){
          const page=pages.find(p=>p.id===id);if(only.checked&&!page.bookmarked)continue;
          const preview=el('span',{className:'page-thumbnail','data-page':id});
          const open=button('',()=>{actions.jump(id);finish(null);});open.append(preview,el('span',{},`${page.bookmarked?'★ ':''}${index+1}ページ`));
          const handle=button('↕',()=>{},'page-drag-handle');handle.setAttribute('aria-label',`${index+1}ページをドラッグして移動`);
          let drag=null;
          handle.addEventListener('pointerdown',e=>{if(busy)return;e.preventDefault();drag={id,pointerId:e.pointerId};handle.setPointerCapture(e.pointerId);});
          handle.addEventListener('pointermove',e=>{
            if(!drag)return;e.preventDefault();const rect=list.getBoundingClientRect();if(e.clientY<rect.top+40)list.scrollTop-=20;if(e.clientY>rect.bottom-40)list.scrollTop+=20;
          });
          handle.addEventListener('pointerup',e=>{
            if(!drag)return;const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-row]')?.dataset.row;drag=null;
            if(target&&target!==id)run(()=>actions.reorder(id,target))();
          });
          handle.addEventListener('pointercancel',()=>{drag=null;});
          const row=el('div',{className:'page-panel-row','data-row':id},handle,open,el('div',{className:'menu-actions'},button('複製',run(()=>actions.duplicate(id))),button('削除',run(()=>actions.remove(id)),'danger'),button('↑',run(()=>actions.step(id,-1))),button('↓',run(()=>actions.step(id,1)))));
          list.append(row);observer.observe(preview);
        }
        if(!list.children.length)list.append(el('p',{},'しおりの付いたページはありません。'));
      }
      only.addEventListener('change',render);render();
      return el('div',{},el('label',{},only,'しおりだけ表示'),el('p',{},'↕をドラッグして並べ替え。↑↓でも移動できます。'),list,button('閉じる',()=>finish(null)));
    });
  } finally {closed=true;observer?.disconnect();for(const url of urls)URL.revokeObjectURL(url);}
}
