---
"lukk-nuxt": patch
---

**BFF: a logout tells the other tabs the moment it is asked for, not only once it lands.** The announcement was made after the request had finished — but the case it exists for is a page that navigates away as it logs out, which cancels that request and everything after it. The other tabs were then never told, and went on showing the account for as long as they stayed open. Only ever seen where the round trip is slow enough for the navigation to win, so it read as a flaky test rather than as the bug it was. Announcing first is sound because the logout note is a cookie by then: it rides the other tabs' own requests, and every server path that reads the session treats a request carrying it as signed out. Direct mode is unchanged — its note is per tab, so a tab told early would renew from the shared cookie, succeed (the session is still live at that point) and learn nothing.
