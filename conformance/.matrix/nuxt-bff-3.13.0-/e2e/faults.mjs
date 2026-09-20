// The specs' handle on the fault proxy in serve.mjs: write the mode, it is read per request.
import { rmSync, writeFileSync } from 'node:fs'

const FILE = process.env.E2E_FAULT_FILE

/** `lukk('refuse')`, `lukk('hang')`, `lukk('fail-logout')`, `lukk('ok')`, or `lukk('ok', 500)` to slow it. */
export function lukk(mode, delayMs = 0) {
  if (!FILE) throw new Error('E2E_FAULT_FILE is unset — start the app through e2e/serve.mjs')
  if (mode === 'ok' && !delayMs) return rmSync(FILE, { force: true })
  writeFileSync(FILE, JSON.stringify({ mode, delayMs }))
}

/** Hold finished responses for exactly `path` — `holdResponses(null)` to stop. */
export function holdResponses(path, holdMs = 0) {
  if (!FILE) throw new Error('E2E_FAULT_FILE is unset — start the app through e2e/serve.mjs')
  if (!path) return rmSync(FILE, { force: true })
  writeFileSync(FILE, JSON.stringify({ mode: 'ok', holdPath: path, holdMs }))
}
