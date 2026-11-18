import { openDatabase } from './storage/db.js';
import { mountLibrary } from './ui/library.js';
import { mountEditor } from './ui/editor.js';
import { createNavigation } from './navigation.js';

const root = document.querySelector('#app'), notice = document.querySelector('#notice');
const report = message => {
  const text=document.createElement('span'), close=document.createElement('button'); text.textContent=message; close.textContent='閉じる'; close.setAttribute('aria-label','通知を閉じる'); close.onclick=()=>{notice.hidden=true;};
  notice.replaceChildren(text,close); notice.hidden=false;
};
async function start() {
  const repository = await openDatabase();
  await repository.collectFiles();
  // Persistence is best effort; permission refusal must not prevent opening notes.
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch { /* Unsupported / denied. */ }
  async function load() {
    const data = await repository.load();
    if (data.warnings.length) report(`保存データに問題があります。以下のデータは削除せず、表示から除外しました。\n${data.warnings.join('\n')}`);
    else { notice.hidden = true; notice.textContent = ''; }
    return data;
  }
  const { library } = createNavigation({ root, repository, load, mountLibrary, mountEditor, report });
  await library();
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) report('新しい版の準備ができました。保存済みを確認し、すべてのアプリ画面を閉じて開き直すと更新されます。');
          if (worker.state === 'redundant') report('オフライン用の準備が完了しませんでした。オンラインで開き直してください。');
        });
      });
    } catch (error) { report(`オフライン用の準備ができませんでした: ${error.message}`); }
  }
}
start().catch(error => { root.textContent = 'ノートを開けませんでした。画面を再読み込みしてください。'; report(error.message); });
