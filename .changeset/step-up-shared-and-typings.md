---
"lukk-nuxt": patch
---

**An unearnable step-up reaches the action waiting on it from another component.** The 403 that makes a step-up impossible was held per `useLukkConfirmation()` instance, so when the modal confirming and the page waiting in `withConfirmation()` were different instances — the usual shape — the page's action rejected as "cancelled" instead of with the 403. It is now held per app. **`$lukkRestore` is typed in templates**, like `$lukk` and `$lukkRefresh`.
