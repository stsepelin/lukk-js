import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The composables' published types, checked where they are published.
 *
 * `nuxt-module-build` emits declarations without `#imports`, so an inferred return type shipped as `any`
 * — and nothing noticed: vitest strips types, and `nuxi typecheck playground` resolves `#imports`, where
 * the inference is precise. So this type-checks `types-composables.assertions.ts` in a program that
 * CANNOT resolve `#imports` either. Any member not covered by a declared interface degrades to `any`,
 * which fails an `expectTypeOf` or leaves a `@ts-expect-error` unused.
 */
const assertions = fileURLToPath(new URL('./types-composables.assertions.ts', import.meta.url))

function check(): { assertionErrors: string[], unresolvedImports: number } {
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
  const text = (d: ts.Diagnostic) => ts.flattenDiagnosticMessageText(d.messageText, '\n')

  return {
    assertionErrors: errors
      .filter(d => d.file?.fileName === assertions)
      .map(d => `L${d.file!.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ${text(d)}`),
    unresolvedImports: errors.filter(d => d.code === 2307 && text(d).includes('#imports')).length,
  }
}

describe('published composable types', () => {
  it('stay precise without #imports — no member degrades to any, internal state stays read-only', () => {
    const { assertionErrors, unresolvedImports } = check()

    // The harness only proves something while it reproduces the build: were `#imports` ever shimmed
    // here, inference would be precise again and every assertion would pass vacuously.
    expect(unresolvedImports).toBeGreaterThan(0)
    expect(assertionErrors).toEqual([])
  }, 60_000)
})
