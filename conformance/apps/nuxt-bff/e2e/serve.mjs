// E2E server launcher: run the PRODUCTION Nitro preview on an internal http port
// and terminate TLS in front of it with a tiny HTTPS reverse proxy. The browser
// then talks https (so it accepts lukk's Secure __Host- session cookie) while the
// app under test is the real production build — no dev-server compile races.
//
// Headers (incl. Host + Origin) are forwarded verbatim, so the BFF's same-origin
// CSRF check still sees Host == Origin == localhost:<PORT>.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:https'

const PORT = Number(process.env.E2E_PORT ?? 3100)
const UPSTREAM = Number(process.env.E2E_UPSTREAM_PORT ?? 3101)

// Start the Nitro preview (built by `nuxi build`) on the internal port.
const preview = spawn('node', ['.output/server/index.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(UPSTREAM), NITRO_PORT: String(UPSTREAM) },
})
const shutdown = () => { preview.kill(); process.exit() }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

const tls = { key: readFileSync(process.env.E2E_SSL_KEY), cert: readFileSync(process.env.E2E_SSL_CERT) }

createServer(tls, (req, res) => {
  const upstream = request(
    { host: '127.0.0.1', port: UPSTREAM, method: req.method, path: req.url, headers: req.headers },
    (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res) },
  )
  upstream.on('error', (e) => { res.writeHead(502); res.end(String(e)) })
  req.pipe(upstream)
}).listen(PORT, 'localhost', () => {
  console.log(`[e2e] https://localhost:${PORT} -> nitro http://127.0.0.1:${UPSTREAM}`)
})
