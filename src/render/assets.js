import { openPdf, PDF_ANNOTATION_MODE } from '../import/pdf.js';
import { loadImage } from '../import/images.js';
export async function pageAssets(page,getFile,ratio=1,signal) {
  const images=new Map(); let background=null;
  try {
    if (page.background) {
      const file=await getFile(page.background.fileId);
      if (page.background.type === 'pdf') {
        const pdf=await openPdf(file.blob,signal),abort=()=>{void pdf.destroy();};
        signal?.addEventListener('abort',abort,{once:true});
        try {
          const source=await pdf.getPage(page.background.pageIndex+1), viewport=source.getViewport({scale:ratio}), canvas=document.createElement('canvas');
          canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height); background=canvas;
          await source.render({canvasContext:canvas.getContext('2d'),viewport,annotationMode:PDF_ANNOTATION_MODE}).promise;
        } finally { signal?.removeEventListener('abort',abort);await pdf.destroy(); }
      } else background=await loadImage(file.blob);
    }
    signal?.throwIfAborted();
    for (const item of page.items) if (item.type==='image' && !images.has(item.fileId)) {signal?.throwIfAborted();images.set(item.fileId,await loadImage((await getFile(item.fileId)).blob));}
    return {background,images,release() { if (background?.getContext) background.width=background.height=0; else if (background) background.src=''; for (const image of images.values()) image.src=''; images.clear(); }};
  } catch(error) { if (background?.getContext) background.width=background.height=0; else if(background) background.src=''; for(const image of images.values()) image.src=''; throw error; }
}
