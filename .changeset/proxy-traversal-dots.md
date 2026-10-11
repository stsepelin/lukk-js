---
"lukk-nuxt": patch
---

**The app-API proxy refuses traversal-shaped paths.** A path in which a round of percent-decoding reveals a whole `.` or `..` segment — encoded twice, split by a tab, LF or CR (`.%2509.`), or behind an encoded separator h3 leaves encoded (`a%2F..%2Fb`, `a%5c..%5cb`) — answers `404`, so a chain of rewriting hops in front of the app cannot walk it onto lukk's routes.
