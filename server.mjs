// Zero-dependency Node server: static files + proxy for the OpenRouter Decisions API.
// The API key lives server-side only (env OPENROUTER_API_KEY or .env file), never in the browser.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4317);
const MODEL = 'typesafe/jev-1.13';
const UPSTREAM = 'https://openrouter.ai/api/alpha/decisions';
const UPSTREAM_ALT = 'https://openrouter.ai/api/v1/alpha/decisions';

function loadKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  const envFile = path.join(__dirname, '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*OPENROUTER_API_KEY\s*=\s*(\S+)\s*$/);
      if (m) return m[1];
    }
  }
  return null;
}
const API_KEY = loadKey();
console.log(`[server] API key: ${API_KEY ? 'configured' : 'MISSING (set OPENROUTER_API_KEY env or .env file)'}`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? 'index.html' : pathname.slice(1);
  file = path.normalize(path.join(PUBLIC, file));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return send(res, 403, '{"error":"forbidden"}');
  try {
    const data = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    send(res, 404, JSON.stringify({ error: { code: 404, message: 'not found' } }));
  }
}

function readBody(req, limit = 200000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function proxyDecide(bodyObj) {
  if (!API_KEY) {
    return { status: 500, text: JSON.stringify({ error: { code: 500, message: 'OPENROUTER_API_KEY not set on server (env var or .env)' } }) };
  }
  const payload = { model: MODEL, ...bodyObj };
  for (const url of [UPSTREAM, UPSTREAM_ALT]) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      console.log(`[decide] ${url} -> ${res.status} (${Date.now() - t0}ms)`);
      if (res.status === 404) continue; // try alt endpoint
      return { status: res.status, text };
    } catch (e) {
      console.log(`[decide] ${url} error: ${e.name}: ${e.message}`);
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        return { status: 504, text: JSON.stringify({ error: { code: 504, message: 'upstream timeout (20s)' } }) };
      }
      return { status: 502, text: JSON.stringify({ error: { code: 502, message: e.message } }) };
    }
  }
  return { status: 404, text: JSON.stringify({ error: { code: 404, message: 'decisions endpoint not found' } }) };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && u.pathname === '/api/health') {
      return send(res, 200, JSON.stringify({
        ok: true, model: MODEL, keyConfigured: !!API_KEY,
        decisionsEndpoint: UPSTREAM, uptime: Math.round(process.uptime()),
      }));
    }
    if (req.method === 'POST' && u.pathname === '/api/decide') {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, JSON.stringify({ error: { code: 400, message: 'invalid JSON' } })); }
      if (!body || typeof body !== 'object' || !body.state || !body.questions) {
        return send(res, 400, JSON.stringify({ error: { code: 400, message: 'state and questions are required' } }));
      }
      const { status, text } = await proxyDecide(body);
      return res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }) && res.end(text);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, u.pathname);
    send(res, 405, JSON.stringify({ error: { code: 405, message: 'method not allowed' } }));
  } catch (e) {
    console.log('[server] error:', e.message);
    try { send(res, 500, JSON.stringify({ error: { code: 500, message: e.message } })); } catch { /* ignore */ }
  }
});

server.listen(PORT, () => {
  console.log(`[server] Pac-Man + Jev 1.13 on http://localhost:${PORT}`);
});
