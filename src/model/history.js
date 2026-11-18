export class History {
  constructor(limit = 50) { this.limit = limit; this.past = []; this.future = []; }
  commit(before, after) {
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    this.past.push(structuredClone(before));
    if (this.past.length > this.limit) this.past.shift();
    this.future = []; return true;
  }
  undo(current) { if (!this.past.length) return current; this.future.push(structuredClone(current)); return this.past.pop(); }
  redo(current) { if (!this.future.length) return current; this.past.push(structuredClone(current)); return this.future.pop(); }
  removeMissingFiles(available) {
    const usable = entry => (!entry.background || available.has(entry.background.fileId)) &&
      (entry.items || []).every(item => item.type !== 'image' || available.has(item.fileId));
    const count = this.past.length + this.future.length;
    this.past = this.past.filter(usable); this.future = this.future.filter(usable);
    return count - this.past.length - this.future.length;
  }
}
