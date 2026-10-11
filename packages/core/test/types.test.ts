import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The published types, checked. vitest strips types and `tsc --noEmit` covers `src/` only, so a return type
 * that disagrees with what lukk sends — `Promise<void>` for a call answering `{"status": "..."}` — passed
 * every gate. This type-checks `types.assertions.ts` the way a consumer's compiler would.
 */
const assertions = fileURLToPath(new URL('./types.assertions.ts', import.meta.url))

describe('published client types', () => {
  it('match the responses lukk sends', () => {
    const program = ts.createProgram([assertions], {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
    })
    const errors = ts.getPreEmitDiagnostics(program)
      .filter(d => d.file?.fileName === assertions)
      .map(d => `L${d.file!.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)

    expect(errors).toEqual([])
  }, 30_000)
})
