---
"lukk-nuxt": patch
---

**A rotation's straggler window starts when its cookie leaves.** A link was given its 30 seconds when the rotation landed, but the app-API proxy and SSR deliver the cookie only when the upstream's headers arrive or the page renders — a long-poll or a slow upload left the browser on the consumed token after the window had closed, and its next refresh was revoked. Links are now held until a caller's cookie carrying their pair actually leaves — including on the error response when the upstream is unreachable, and not when the browser went away before the upstream answered.

**Step-up and `/refresh` seal the newest pair.** A step-up confirmation re-sealed the session's tokens as they arrived, even when another request had rotated them meanwhile; `/api/_lukk/refresh` sealed without re-checking. Both now seal the newest pair, and answer `409` for a pair the session has moved past.

**A page render's own app-API requests never rotate the session** — the rotated cookie went back to the render, not the browser, which then replayed the consumed token. This covers Nuxt's own `useFetch('/api/…')`, `useRequestFetch()` and `event.$fetch` too: a BFF server plugin marks the page request itself (`x-lukk-ssr`, removed before the request reaches your API), so every request the render makes carries it. SSR hydration is the one place a render renews the session; with `ssrHydrate: false`, an SSR app-API call on an expired access token answers `401` during the render and the client renews after hydration.

**The app-API proxy refuses lukk's routes behind a PHP front controller** (`/api/index.php/auth/login`), which Laravel routes like `/auth/login` — any `.php` segment, so an app under a sub-path (`/app/index.php/auth/login`) too. **A refresh answer whose body breaks off** is an outage (`503`), not a `500` for every request sharing it.
