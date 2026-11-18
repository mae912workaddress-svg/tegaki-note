let library;
// PDF.js AnnotationMode.ENABLE: paint widgets and annotations into the canvas.
export const PDF_ANNOTATION_MODE = 1;
export async function openPdf(blob, signal) {
  signal?.throwIfAborted();
  library ||= import('../../vendor/pdfjs/pdf.mjs');
  const pdfjs = await library;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
  signal?.throwIfAborted();
  const task = pdfjs.getDocument({ data:new Uint8Array(await blob.arrayBuffer()), cMapUrl:new URL('../../vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked:true, standardFontDataUrl:new URL('../../vendor/pdfjs/standard_fonts/', import.meta.url).href, isEvalSupported:false });
  let rejectBlocked, passwordRequired = false;
  const blocked=new Promise((_,reject)=>{rejectBlocked=reject;});
  const abort=()=>{rejectBlocked(signal.reason);void task.destroy();};
  signal?.addEventListener('abort',abort,{once:true});
  task.onPassword = () => { passwordRequired = true; rejectBlocked(new Error('パスワード付きPDFは読み込めません')); void task.destroy(); };
  try { const doc=await Promise.race([task.promise,blocked]);signal?.throwIfAborted();return doc; }
  catch(error) { await task.destroy(); if(signal?.aborted)throw error;if(passwordRequired)throw new Error('パスワード付きPDFは読み込めません');throw new Error('PDFを開けません。破損またはパスワード付きPDFは読み込めません。'); }
  finally {signal?.removeEventListener('abort',abort);}
}

export async function validatePdfPage(page) {
  const view = page.getViewport({ scale:1 });
  if (![view.width, view.height].every(n => Number.isFinite(n) && n > 0)) throw new Error('PDFのページ寸法が不正です');
  await page.getOperatorList({ annotationMode:PDF_ANNOTATION_MODE });
  return view;
}
