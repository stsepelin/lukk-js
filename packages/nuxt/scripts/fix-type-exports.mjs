// @nuxt/module-builder 0.8 re-exports every named export from the type entry as `export { type X }`,
// so a consumer's `import { LUKK_BFF_PREFIX } from 'lukk-nuxt'` fails with TS1362 ("cannot be used as a
// value") although the runtime module exports the value. Re-export them as values.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** `export { type A, type B } from './module.js'` → `export { A, B } from './module.js'`. */
export function valueExports(source) {
  return source.replace(/export \{([^}]*)\} from '(\.\/module(?:\.js)?)'/g, (_, names, from) =>
    `export {${names.replace(/\btype\s+/g, '')}} from '${from}'`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const file of ['dist/types.d.mts', 'dist/types.d.ts']) {
    try {
      writeFileSync(file, valueExports(readFileSync(file, 'utf8')))
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}
