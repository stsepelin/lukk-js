#!/usr/bin/env bash
# Run one committed E2E app against SEVERAL Nuxt versions.
#
# The apps under `conformance/apps/` are workspace packages pinned to one Nuxt version, so the browser
# suites only ever proved the module against that one. Copying an app per version by hand is what every
# ad-hoc verification round ended up doing; this does it once, from the same sources and the same specs.
#
# For each version it materialises `conformance/.matrix/<app>-<version>/`: the app's own files (pages,
# config, specs, server launcher) plus a generated `package.json` pinning that Nuxt and LINKING
# `lukk-nuxt` back to the workspace, installed outside the workspace so its own pin wins. The install is
# kept between runs — the first run per version pays for it, later ones start in seconds.
#
# `.matrix/` is generated and gitignored; the app directory stays the single source of truth.

# The declared floor (`@nuxt/kit: ^3.13.0` → `3.13.0`), so raising it moves the matrix with it.
nuxt_floor() {
  local repo_root="$1"
  node -e "const p=require('$repo_root/packages/nuxt/package.json');process.stdout.write((p.dependencies['@nuxt/kit']||'').replace(/^[^0-9]*/,''))"
}

# `floor` → the declared floor; `3` / `4` → the newest of that major; anything else is used verbatim.
resolve_nuxt_version() {
  local repo_root="$1" spec="$2"
  case "$spec" in
    floor) nuxt_floor "$repo_root" ;;
    3 | 4) echo "^$spec" ;;
    *) echo "$spec" ;;
  esac
}

# Copy the app + pin the version. Echoes the prepared directory.
prepare_matrix_app() {
  local repo_root="$1" app_dir="$2" version="$3"
  local app_name out
  app_name="$(basename "$app_dir")"
  out="$repo_root/conformance/.matrix/$app_name-$(echo "$version" | tr -c 'a-zA-Z0-9.' '-')"

  mkdir -p "$out"
  # Sources only: never the installed tree, the build output, or a previous run's artefacts.
  rsync -a --delete \
    --exclude node_modules --exclude .nuxt --exclude .output --exclude dist \
    --exclude test-results --exclude playwright-report \
    "$app_dir/" "$out/"

  # PACKED, not linked: a symlinked package resolves its own copy of vue/nuxt from the workspace, and
  # the app then runs two Vue instances — state the module writes lands in one and the page reads the
  # other (a 2FA challenge that never shows, a cross-tab logout no other tab sees). A tarball is also
  # what a consumer actually installs.
  pnpm -C "$repo_root/packages/core" pack --pack-destination "$out" >/dev/null || return 1
  pnpm -C "$repo_root/packages/nuxt" pack --pack-destination "$out" >/dev/null || return 1
  ( cd "$out" && mv lukk-core-*.tgz lukk-core.tgz && mv lukk-nuxt-*.tgz lukk-nuxt.tgz )

  node - "$app_dir/package.json" "$out/package.json" "$version" "$repo_root" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')
const [, , from, to, version, repoRoot] = process.argv
const pkg = JSON.parse(readFileSync(from, 'utf8'))
pkg.name = `${pkg.name}-matrix`
pkg.dependencies = { ...pkg.dependencies, 'nuxt': version, 'lukk-nuxt': 'file:./lukk-nuxt.tgz' }
// `pnpm pack` rewrites `workspace:*` to the version, which would pull lukk-core from the REGISTRY —
// the published one, not the one under test. The override points it back at the local pack.
pkg.pnpm = { ...pkg.pnpm, overrides: { ...pkg.pnpm?.overrides, 'lukk-core': 'file:./lukk-core.tgz' } }
// Playwright EXACTLY as the source app resolved it: a caret would float to a release whose browser
// build isn't the one installed here, and every spec would fail on a missing executable.
const playwright = require(`${from.replace(/package\.json$/, '')}node_modules/@playwright/test/package.json`).version
pkg.devDependencies = { ...pkg.devDependencies, '@playwright/test': playwright }
writeFileSync(to, `${JSON.stringify(pkg, null, 2)}\n`)
NODE

  echo "$out"
}

# Install (and report what Nuxt actually resolved to — a caret range moves).
install_matrix_app() {
  local out="$1"
  pnpm -C "$out" install --ignore-workspace --config.confirmModulesPurge=false >/dev/null 2>&1 \
    || pnpm -C "$out" install --ignore-workspace || return 1
  # Cheap when the browser is already there; the version pin above keeps it to one download.
  pnpm -C "$out" exec playwright install chromium >/dev/null 2>&1 || true
  node -e "process.stdout.write(require('$out/node_modules/nuxt/package.json').version)"
}
