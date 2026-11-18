// One transition owns cleanup at a time; a newer request invalidates pending loads.
export function createNavigation({ root, repository, load, mountLibrary, mountEditor, report }) {
  let cleanup = () => {}, tail = Promise.resolve(), generation = 0;
  const transition = (id, pageId) => {
    const requested = ++generation;
    const run = tail.then(async () => {
      if (requested !== generation) return;
      await cleanup(); cleanup = () => {};
      if (requested !== generation) return;
      let editing;
      try {
        if (id !== undefined) { editing = repository.retainEditingFiles(); await editing.ready; }
        const data = await load();
        if (requested !== generation) return;
        if (id === undefined) cleanup = mountLibrary(root, repository, data, { openNotebook, reload:library, report });
        else {
          const notebook = data.notebooks.find(n => n.id === id);
          if (!notebook) throw new Error('ノートを開けません。保存データの警告を確認してください。');
          cleanup = mountEditor(root, repository, notebook, data.pages.filter(p => p.notebookId === id), { back:library, report, initialPageId:pageId, editing });
          editing = null; // The mounted editor now owns this session.
        }
      } finally { if (editing) await editing.release({ collect:false }); }
    });
    tail = run.catch(() => {});
    return run;
  };
  const library = () => transition();
  const openNotebook = (id, pageId) => transition(id, pageId);
  return { library, openNotebook };
}
