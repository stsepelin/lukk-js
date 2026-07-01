---
"lukk-nuxt": patch
---

Fix `$lukkRefresh is not a function` crashing every page load in BFF mode. `initSession` now reads the injected `$lukkRefresh` defensively (as `useLukkFetch` already did), so if the client plugin's provide isn't in effect yet it degrades to logged-out instead of throwing an app-wide error. The client plugin is also named (`lukk:client`) and the session-restore plugin now `dependsOn` it, guaranteeing the `$lukk` / `$lukkRefresh` provide is established before `initSession` runs — even under parallel plugins or layers.
