// `factory dashboard`: serves the factory directory on 127.0.0.1 so dashboard/index.html can poll it.
// Directories are listed as HTML pages of links, in the format dashboard/index.html parses
// (`<a href="name/">`), and a directory holding an index.html is served as that page. Nothing outside
// the factory directory is served: a path with a ".." segment, or one that resolves (through a
// symlink) outside it, is refused, and so is anything under a `.git` directory.
import { createReadStream, readdirSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, sep } from 'node:path';
import { Refused } from './factory.ts';
import type { Io } from './factory.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c] ?? c);

/** Percent-encode a path segment the way the dashboard's decodeURIComponent expects. */
const quote = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function listing(urlPath: string, dir: string): string {
  const names = readdirSync(dir).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
  const items = names.map((name) => {
    let isDir = false;
    try {
      isDir = statSync(join(dir, name)).isDirectory();
    } catch {
      // a dangling symlink: list it as a file
    }
    const link = isDir ? `${name}/` : name;
    return `<li><a href="${quote(name)}${isDir ? '/' : ''}">${escapeHtml(link)}</a></li>`;
  });
  const title = `Directory listing for ${escapeHtml(urlPath)}`;
  return (
    `<!DOCTYPE HTML>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n` +
    `<body>\n<h1>${title}</h1>\n<hr>\n<ul>\n${items.join('\n')}\n</ul>\n<hr>\n</body>\n</html>\n`
  );
}

function send(res: ServerResponse, status: number, body: string, head: boolean): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(head ? undefined : body);
}

/** The file system path a request maps to, or an HTTP status to refuse it with. */
export function mapPath(root: string, rawUrl: string): string | number {
  const pathPart = rawUrl.split(/[?#]/, 1)[0] ?? '';
  if (!pathPart.startsWith('/')) return 400;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return 400;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return 400;
  const segments = decoded.split('/').filter((x) => x !== '');
  if (segments.some((x) => x === '..' || x === '.')) return 403;
  // A remote factory's jobs/ is a git checkout: its .git (remote URL, config) is not served.
  if (segments.some((x) => x.toLowerCase() === '.git')) return 404;
  const target = join(root, ...segments);
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return 404;
  }
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return 403;
  return target;
}

function handle(root: string, req: IncomingMessage, res: ServerResponse): void {
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) {
    res.setHeader('Allow', 'GET, HEAD');
    send(res, 405, 'method not allowed\n', head);
    return;
  }
  const rawUrl = req.url ?? '/';
  const mapped = mapPath(root, rawUrl);
  if (typeof mapped === 'number') {
    send(res, mapped, mapped === 404 ? 'not found\n' : 'refused\n', head);
    return;
  }
  let st: Stats;
  try {
    st = statSync(mapped);
  } catch {
    send(res, 404, 'not found\n', head);
    return;
  }
  let file = mapped;
  const pathPart = rawUrl.split(/[?#]/, 1)[0] ?? '/';
  if (st.isDirectory()) {
    if (!pathPart.endsWith('/')) {
      res.writeHead(301, { Location: `${pathPart}/`, 'Content-Length': 0 });
      res.end();
      return;
    }
    const index = join(mapped, 'index.html');
    let hasIndex = false;
    try {
      hasIndex = statSync(index).isFile();
    } catch {
      // no index page
    }
    if (!hasIndex) {
      let body: string;
      try {
        body = listing(decodeURIComponent(pathPart), mapped);
      } catch {
        send(res, 404, 'not found\n', head);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(head ? undefined : body);
      return;
    }
    file = index;
    st = statSync(index);
  } else if (!st.isFile()) {
    send(res, 404, 'not found\n', head);
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (head) {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** Serve until SIGINT or SIGTERM. Resolves when the server has closed. */
export function serveDashboard(root: string, port: number, io: Io): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => handle(root, req, res));
    server.on('error', (error) => reject(new Refused(`cannot serve on 127.0.0.1:${port}: ${error.message}`)));
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as AddressInfo).port;
      io.stdout(`dashboard: http://127.0.0.1:${actual}/  (serving ${root}, Ctrl-C to stop)\n`);
      const stop = (): void => {
        server.close(() => resolve());
        server.closeAllConnections();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  });
}
