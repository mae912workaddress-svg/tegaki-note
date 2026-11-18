import { createNotebook, createPage, uid } from '../model/notebooks.js';
import { imagePageLayout } from '../model/images.js';
import { prepareImage } from './images.js';
import { openPdf } from './pdf.js';
import { validatePdfContents } from '../model/validation.js';
import { assertRecords } from '../storage/backup.js';
export async function importFiles(input, folderId = null, adapters = {}) {
  const inputs = [...input]; if (!inputs.length) throw new Error('ファイルを選んでください');
  const prepare = adapters.prepareImage || prepareImage, pdfOpen = adapters.openPdf || (async file => { await validatePdfContents(file, adapters); return openPdf(file); });
  const result = { folders:[], notebooks:[], pages:[], files:[] }; let jpgNotebook;
  for (const file of inputs) {
    const head = new Uint8Array(await file.slice(0,5).arrayBuffer());
    const isPdf = String.fromCharCode(...head) === '%PDF-';
    const name = (file.name || '読み込み').replace(/\.[^.]+$/,'').slice(0,100);
    if (isPdf) {
      const pdf = await pdfOpen(file), fileId = uid();
      try {
        const {notebook} = createNotebook({name}); notebook.pageIds=[];
        for (let i=0;i<pdf.numPages;i++) {
          const source = await pdf.getPage(i+1), view = source.getViewport({scale:1});
          const page = createPage(notebook.id,{width:view.width,height:view.height});
          page.background={type:'pdf',fileId,pageIndex:i};
          const text = await source.getTextContent(); page.text=text.items.map(t => t.str + (t.hasEOL ? '\n' : ' ')).join('');
          notebook.pageIds.push(page.id); result.pages.push(page); source.cleanup();
        }
        result.notebooks.push(notebook); result.files.push({id:fileId,name:file.name,mime:'application/pdf',blob:new Blob([file],{type:'application/pdf'})});
      } finally { await pdf.destroy(); }
    } else {
      const image=await prepare(file);
      if (!jpgNotebook) { jpgNotebook=createNotebook({name}).notebook; jpgNotebook.pageIds=[]; result.notebooks.push(jpgNotebook); }
      const layout=imagePageLayout(image.width,image.height), page=createPage(jpgNotebook.id,layout);
      page.background={type:'image',fileId:image.id,...layout.placement}; jpgNotebook.pageIds.push(page.id); result.pages.push(page); result.files.push(image);
    }
  }
  assertRecords(result);
  for (const notebook of result.notebooks) notebook.folderId=folderId;
  return result;
}
