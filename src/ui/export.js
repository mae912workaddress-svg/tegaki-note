import { el,button,field,option,dialog } from './dom.js';
import { exportPdf } from '../export/pdf.js';
import { exportJpg,exportPages,safeName,shareOrDownload } from '../export/files.js';
import { rasterizePage,rasterizeText } from '../export/raster.js';
export function exportDialog(notebook,pages,repository,report,currentId=notebook.pageIds[0]) {
  return dialog('書き出し',finish => {
    const format=el('select',{},option('pdf','PDF'),option('jpg','JPG'));
    const range=el('select',{},option('all','全ページ'),option('current','現在のページ'));
    const status=el('p',{role:'status'}), output=el('div',{className:'menu-actions'}); let files=[];
    const share=button('共有',() => { shareOrDownload(files,report).catch(error => { if(error.name!=='AbortError') status.textContent=error.message; }); }); share.hidden=true;
    const create=button('作成',async () => {
      create.disabled=true; share.hidden=true; output.replaceChildren(); status.textContent='作成中…';
      format.disabled=range.disabled=true;
      try {
        const getFile=id=>repository.getFile(id);
        files=format.value==='pdf' ? [new File([await exportPdf(exportPages(notebook,pages,range.value,currentId),{getFile,rasterizeText})],`${safeName(notebook.name)}.pdf`,{type:'application/pdf'})] : await exportJpg(notebook,pages,p=>rasterizePage(p,getFile),range.value,currentId);
        status.textContent=`${files.length}ファイルを作成しました。「共有」からメールや「ファイルに保存」を選んでください。`; share.hidden=false;
        // A separate tap per file is available when browsers block multiple downloads.
        if (!navigator.canShare?.({files}) && files.length>1) for (const file of files) output.append(button(`${file.name} を保存`,()=>shareOrDownload([file],report).catch(e=>report(e.message))));
      } catch(error) { status.textContent=error.message; } finally { create.disabled=false;format.disabled=range.disabled=false; }
    },'primary');
    for (const select of [format,range]) select.addEventListener('change',()=>{files=[];share.hidden=true;output.replaceChildren();status.textContent='条件を変更しました。「作成」を押してください。';});
    return el('div',{},field('形式',format),field('範囲',range),status,output,el('div',{className:'actions'},button('閉じる',()=>finish(null)),create,share));
  });
}
export function preparedShareDialog(file,report) {
  return dialog('バックアップを作成しました',finish=>el('div',{},el('p',{},'共有から「ファイルに保存」、AirDrop、メールを選べます。'),button('共有',()=>shareOrDownload([file],report).catch(e=>{if(e.name!=='AbortError')report(e.message);})),button('閉じる',()=>finish(null))));
}
