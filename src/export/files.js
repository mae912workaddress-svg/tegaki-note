export const safeName = name => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,100) || 'ノート';
export function exportPages(notebook,pages,range='all',currentId=notebook.pageIds[0]) {
  const byId=new Map(pages.map(p=>[p.id,p]));
  const ids=range==='current' ? [currentId] : notebook.pageIds;
  return ids.map(id => { const page=byId.get(id); if(!page) throw new Error('書き出すページがありません'); return page; });
}
export function rasterSize(page,dpi=200) {
  const ratio=Math.min(dpi/72,Math.sqrt(4000000/(page.width*page.height)),4096/Math.max(page.width,page.height));
  return {width:Math.max(1,Math.floor(page.width*ratio)),height:Math.max(1,Math.floor(page.height*ratio)),ratio};
}
export async function exportJpg(notebook,pages,render,range='all',currentId) {
  const files=[];
  for (const page of exportPages(notebook,pages,range,currentId)) {
    const number=String(notebook.pageIds.indexOf(page.id)+1).padStart(2,'0');
    files.push(new File([await render(page)],`${safeName(notebook.name)}_p${number}.jpg`,{type:'image/jpeg'}));
  }
  return files;
}
// Must be called synchronously from a user tap, after files have been prepared.
export function shareOrDownload(files,report,nav=navigator,doc=document) {
  if (nav.canShare?.({files}) && nav.share) return nav.share({files});
  for (const file of files) {
    const url=URL.createObjectURL(file), a=doc.createElement('a'); a.href=url; a.download=file.name; doc.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  report('ダウンロードを開始しました'); return Promise.resolve();
}
