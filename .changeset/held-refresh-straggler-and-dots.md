---
"lukk-nuxt": patch
---

**A taken rotation outlives its taker's own next refresh.** When the access token it handed out had already expired while the rotation was held, the taker refreshed at once — presenting the token the hold handed out — and that dropped the hold while requests from the same burst were still on their way with the consumed token; those reached lukk long past its grace window and revoked the session. Presenting the handed-out token no longer ends the 30-second straggler window, and the hold follows the taker's rotation: a straggler then receives the taker's new pair, counted down from when it was minted, rather than re-sealing the token the taker just spent — whose replay, lukk's grace window being no longer than the straggler window, could still revoke the session. The window is never extended, a token outside the session's own chain still ends it, and nothing is forwarded for a session that was logged out or replaced.

**The app-API proxy refuses more traversal-shaped paths.** A dot segment that a tab, LF or CR splits (`.%2509.`), and one behind an encoded separator h3 leaves encoded (`a%2F..%2Fb`, `a%5c..%5cb`), now answer `404`.
