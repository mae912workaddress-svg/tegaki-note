import http from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream' };
export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      let pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const parts = pathname.split(/[\\/]/).filter(Boolean);
      if (parts.some(p => p.startsWith('.') || p === 'node_modules' || p === 'package-lock.json')) throw new Error('Private path');
      const file = await realpath(path.resolve(root, `.${pathname}`));
      const relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(file)).isFile()) throw new Error('Invalid path');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer(), port = Number(process.env.PORT || 4173);
  server.listen(port, '127.0.0.1', () => console.log(`てがきノート: http://127.0.0.1:${server.address().port}/`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
