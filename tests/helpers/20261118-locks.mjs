// Web Locks transport double: owners share one manager; closing a tab releases
// its locks even when its callback promise never settles.
export function createLocks() {
  const active = new Set(), queue = [];
  const available = job => ![...active].some(lock => lock.name === job.name && (job.mode === 'exclusive' || lock.mode === 'exclusive'));
  function drain() {
    while (queue.length && available(queue[0])) {
      const job = queue.shift(); active.add(job);
      queueMicrotask(() => {
        if (!active.has(job)) return;
        Promise.resolve().then(() => job.callback({ name:job.name, mode:job.mode }))
          .then(value => finish(job, null, value), error => finish(job, error));
      });
    }
  }
  function finish(job, error, value) {
    if (!active.delete(job)) return;
    if (error) job.reject(error); else job.resolve(value);
    drain();
  }
  function client() {
    const owner = {};
    return {
      requestLock(name, options, callback) {
        return new Promise((resolve, reject) => {
          const job = { name, mode:options.mode, callback, resolve, reject, owner };
          if (options.ifAvailable && (queue.length || !available(job))) {
            Promise.resolve().then(() => callback(null)).then(resolve, reject); return;
          }
          queue.push(job); drain();
        });
      },
      close(error) {
        for (const job of [...active]) if (job.owner === owner) finish(job, error);
      }
    };
  }
  return { client };
}
