# Upgrade Guide

This guide lists every change across `lukk-core` and `lukk-nuxt` that **requires action on
upgrade** — a changed default, a renamed export, a config shape change, anything that can
surprise an existing install. For the full per-release detail (features, fixes), read each
package's changelog; this file is only the "you may need to do something" subset.

- [`lukk-core` CHANGELOG](packages/core/CHANGELOG.md)
- [`lukk-nuxt` CHANGELOG](packages/nuxt/CHANGELOG.md)

**lukk-js is pre-1.0 (`0.x`).** Per [SemVer §4](https://semver.org/#spec-item-4), a **minor**
bump (`0.x.0`) may carry a breaking change; a **patch** bump (`0.x.y`) never does. The two
packages version independently (this is a changesets monorepo), so check the changelog for the
package you actually depend on. Each entry below is tagged **High / Medium / Low impact**.

Because lukk-js only ever *speaks* [lukk](https://github.com/stsepelin/lukk)'s HTTP contract,
a server upgrade can also require a client change (or vice-versa) — when it does, the entry
links the matching [lukk `UPGRADE.md`](https://github.com/stsepelin/lukk/blob/main/UPGRADE.md)
section. Upgrade the server first; it's the source of truth.

**Impact key** — _High_: action required or the client will break. _Medium_: action required
only if you use the named feature/mode. _Low_: informational; a behavior changed but the
default is safe.

---

## No breaking changes yet

Every release so far has been additive and backward-compatible — new composables, new options,
and fixes, all opt-in. There is nothing to do beyond bumping the version and reading the
changelog.

When the first breaking change ships, it will be documented here (highest version first) with
the impact tag and the exact migration step, before it lands in a release.
