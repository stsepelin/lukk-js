// E2E server for the DIRECT app: puts the SPA/SSG and the lukk API under ONE https
// origin (so lukk-core's same-origin bearer/cookie gate is satisfied and there's no
// CORS). Terminates TLS on E2E_PORT and routes by path:
//   /auth /user /jwks /conformance /up  → the lukk API (http, E2E_API_PORT)
//   everything else                     → the app (SPA: Nitro preview; SSG: static files)
// E2E_APP_MODE = 'spa' (proxy to a Nitro preview) | 'ssg' (serve .output/public statically).
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:https'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.E2E_PORT ?? 8443)
const API = Number(process.env.E2E_API_PORT ?? 8000)
const SPA = Number(process.env.E2E_SPA_PORT ?? 3101)
const MODE = process.env.E2E_APP_MODE ?? 'spa'
// fileURLToPath (not .pathname) so a path with spaces isn't left percent-encoded.
const PUBLIC = fileURLToPath(new URL('../.output/public/', import.meta.url))

const API_PREFIXES = ['/auth', '/user', '/jwks', '/conformance', '/up']
const isApi = url => API_PREFIXES.some(p => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`))

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }

let preview
if (MODE === 'spa') {
  preview = spawn('node', ['.output/server/index.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(SPA), NITRO_PORT: String(SPA) },
  })
}
const shutdown = () => { preview?.kill(); process.exit() }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

function proxyTo(port, req, res) {
  const up = request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers },
    (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res) })
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)) })
  req.pipe(up)
}

function serveStatic(req, res) {
  // Map to a file under .output/public; fall back to index.html for client routes (SPA).
  let decoded
  try { decoded = decodeURIComponent((req.url ?? '/').split('?')[0]) }
  catch { res.writeHead(400); res.end('bad request'); return } // malformed %-escape
  const path = normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  let file = join(PUBLIC, path)
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const indexed = join(file, 'index.html')
    file = existsSync(indexed) ? indexed : join(PUBLIC, 'index.html')
  }
  // writeHead on 'open' (not up front) so a read error before any bytes can still send a 500;
  // once headers are sent we can only end the response.
  const stream = createReadStream(file)
  stream.on('open', () => res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }))
  stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end() })
  stream.pipe(res)
}

const tls = { key: readFileSync(process.env.E2E_SSL_KEY), cert: readFileSync(process.env.E2E_SSL_CERT) }
createServer(tls, (req, res) => {
  if (isApi(req.url ?? '')) return proxyTo(API, req, res)
  if (MODE === 'ssg') return serveStatic(req, res)
  return proxyTo(SPA, req, res)
}).listen(PORT, 'localhost', () => {
  console.log(`[e2e-direct] https://localhost:${PORT}  (mode=${MODE}; api→${API}${MODE === 'spa' ? `, app→${SPA}` : ', app=static'})`)
})
