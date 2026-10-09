---
"lukk-core": minor
"lukk-nuxt": patch
---

**A refresh the BFF asks to retry is retried.** `LukkError` gains `retryAfter`, the server's `Retry-After` in seconds. When the BFF answers a refresh with `503` and `Retry-After` — lukk is slow to rotate — lukk-nuxt's client waits that long (at most ten seconds) and asks once more, which joins the rotation still in flight or adopts it once it has landed, instead of reporting the session unavailable until the user's next action.
