---
"lukk-nuxt": minor
---

**`useLukkForm`'s `rememberKey` is namespaced.** The draft lived in `useState(rememberKey)`, a key global to the app, so `rememberKey: 'lukk:user'` made the draft the signed-in user's state, and any app key could be overwritten the same way. It now lives at `lukk:form:<rememberKey>`. A draft remembered under the old key is not carried over.

**The cross-tab channel closes with the app.** The `BroadcastChannel` the client plugin opens was never closed; an unmounted app (HMR, a micro-frontend) kept answering other tabs. It is now closed on `app.onUnmount` (Vue 3.5+), and nothing announces on it afterwards.

Also: reading the direct-mode pending-logout note no longer relies on a caught `TypeError` to detect a missing note.
