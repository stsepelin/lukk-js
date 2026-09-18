// E2E server launcher: run the PRODUCTION Nitro preview on an internal http port
// and terminate TLS in front of it with a tiny HTTPS reverse proxy. The browser
// then talks https (so it accepts lukk's Secure __Host- session cookie) while the
// app under test is the real production build — no dev-server compile races.
//
// Headers (incl. Host + Origin) are forwarded verbatim, so the BFF's same-origin
// CSRF check still sees Host == Origin == localhost:<PORT>.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, request } from 'node:http'
import { createServer } from 'node:https'

const PORT = Number(process.env.E2E_PORT ?? 3100)
const UPSTREAM = Number(process.env.E2E_UPSTREAM_PORT ?? 3101)

// A fault-injecting hop between the Nuxt server and the lukk API, so a spec can say "lukk is
// unreachable" or "this logout never lands" without touching the API itself. The mode is read per
// request from a small JSON file the specs write (see e2e/faults.mjs).
const FAULT_PORT = Number(process.env.E2E_FAULT_PORT ?? 8010)
const API_PORT = Number(process.env.E2E_API_PORT ?? 8000)
const FAULT_FILE = process.env.E2E_FAULT_FILE

// Start the Nitro preview (built by `nuxi build`) on the internal port.
const preview = spawn('node', ['.output/server/index.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(UPSTREAM), NITRO_PORT: String(UPSTREAM) },
})
const shutdown = () => { preview.kill(); process.exit() }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Connection-scoped headers belong to THIS hop: forwarding `transfer-encoding`/`trailer` onwards had
// node reject the reply outright (ERR_HTTP_TRAILER_INVALID) and take the whole server down with it.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const hopFree = headers => Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())))

/** `{ mode: 'ok' | 'refuse' | 'hang' | 'fail-logout', delayMs?: number }` — absent file means `ok`. */
function fault() {
  if (!FAULT_FILE) return { mode: 'ok' }
  try { return JSON.parse(readFileSync(FAULT_FILE, 'utf8')) }
  catch { return { mode: 'ok' } }
}

if (FAULT_FILE) {
  createHttpServer((req, res) => {
    const { mode = 'ok', delayMs = 0 } = fault()
    const failing = mode === 'fail-logout' && req.url?.endsWith('/logout')
    if (mode === 'refuse') return res.socket?.destroy()
    if (mode === 'hang') return // no answer, ever: the request is left open
    if (failing) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"message":"lukk is having a moment."}') }

    const forward = () => {
      const upstream = request(
        { host: '127.0.0.1', port: API_PORT, method: req.method, path: req.url, headers: hopFree(req.headers) },
        (up) => { res.writeHead(up.statusCode ?? 502, hopFree(up.headers)); up.pipe(res) },
      )
      upstream.on('error', (e) => { res.writeHead(502); res.end(String(e)) })
      req.pipe(upstream)
    }
    if (delayMs) setTimeout(forward, delayMs)
    else forward()
  }).listen(FAULT_PORT, '127.0.0.1', () => console.log(`[e2e] lukk fault proxy http://127.0.0.1:${FAULT_PORT} -> ${API_PORT}`))
}

const tls = { key: readFileSync(process.env.E2E_SSL_KEY), cert: readFileSync(process.env.E2E_SSL_CERT) }

createServer(tls, (req, res) => {
  // A response the app has finished, held in flight — the gap a CDN, a slow client or a proxy opens,
  // in which another tab can complete a sign-in before this response's cookies land.
  const { holdPath, holdMs = 0 } = fault()
  // Exactly this path, not a prefix: holding `/` would otherwise freeze every page the test opens.
  const hold = holdPath && (req.url ?? '').split('?')[0] === holdPath ? holdMs : 0

  const upstream = request(
    { host: '127.0.0.1', port: UPSTREAM, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      const deliver = () => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res) }
      if (hold) { up.pause(); setTimeout(() => { up.resume(); deliver() }, hold) }
      else deliver()
    },
  )
  upstream.on('error', (e) => { res.writeHead(502); res.end(String(e)) })
  req.pipe(upstream)
}).listen(PORT, 'localhost', () => {
  console.log(`[e2e] https://localhost:${PORT} -> nitro http://127.0.0.1:${UPSTREAM}`)
})
