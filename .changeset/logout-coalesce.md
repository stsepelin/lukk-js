---
"lukk-nuxt": patch
---

**A second `logout()` while one is in progress joins it.** A double click ran two logouts back to back: the second went out after the first had ended the session, got a 401 it couldn't renew, and rejected — leaving behind the logout note it had just written, so the next page load set out to finish a logout that was already done. Concurrent calls now share one logout and both resolve with it. A session that a sign-in issued while a logout was out is still ended by a logout of its own.
