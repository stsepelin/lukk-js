---
"lukk-nuxt": patch
---

**`useLukkFetch`: a per-call `baseURL` that is not a primitive string no longer gets credentials.**

The credential check read any non-string per-call `baseURL` as "no base" and cleared the request on its path alone. But ofetch applies every truthy base, and ufo resolves a boxed `new String('https://collector.example')` to that host, so the bearer and `credentials: 'include'` went there. Judging the object by its string value is not safe either: ufo coerces it twice with different hints, so an object that answers differently to each passes as the API and is sent elsewhere. Such a value is now refused. The request still goes out, without credentials. TypeScript already rejects it, so reaching it takes a cast in the app's own code. `''` and `null` still mean "no per-call base", as they do to ofetch.
