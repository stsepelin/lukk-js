---
"lukk-nuxt": patch
---

**The logout note's cookie names now follow a runtime `cookieSecure` override.** The names the browser writes the BFF logout note (and reads the signed-out answer) under were baked into public runtime config at build, from the build's `cookieSecure`, while the server derived them from the runtime value; overriding it at runtime left the browser writing a note the server never read. The server now restates both names in each request's public config before anything renders, so the page always carries the names its own server reads. Setting `runtimeConfig.public.lukk.logoutCookie` by hand alongside such an override is no longer needed.
