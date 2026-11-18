// Start transactions synchronously during pagehide; retain dirty snapshots on error.
export class Autosave {
  constructor(repository, notify, delay = 500) { this.repository = repository; this.notify = notify; this.delay = delay; this.dirty = new Map(); this.pending = new Set(); this.timer = null; this.revision = 0; }
  mark(page) {
    this.dirty.set(page.id, { page: structuredClone(page), revision: ++this.revision });
    this.notify('未保存'); clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.flush().catch(() => {}); }, this.delay);
  }
  flush() {
    clearTimeout(this.timer);
    const jobs = [];
    for (const [id, entry] of this.dirty) {
      if (entry.saving) continue;
      entry.saving = true;
      let operation;
      try { operation = this.repository.savePage(entry.page); } catch (e) { operation = Promise.reject(e); }
      const job = operation.then(() => { if (this.dirty.get(id) === entry) this.dirty.delete(id); }, error => { entry.saving = false; throw error; });
      this.pending.add(job); jobs.push(job);
      job.then(() => this.pending.delete(job), () => this.pending.delete(job));
    }
    return Promise.all([...this.pending, ...jobs]).then(() => {
      if (this.dirty.size) return this.flush();
      this.notify('保存済み');
    }).catch(error => { this.notify(`保存できません: ${error.message}。この画面を閉じず「再保存」を押してください`, true); throw error; });
  }
}
