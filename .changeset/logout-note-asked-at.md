---
"lukk-nuxt": patch
---

**The logout note carries the moment the logout was asked for, and a few narrower fixes around it.**

- **BFF: a stale note could end the session a sign-in had just created.** The page that finishes a note stamped its own *load* time as "when this logout was asked for", while the evidence that stands a logout down is the moment a sign-in was *sent*. A sign-in already on the wire — sent before that page loaded, landing after it — therefore never counted as "since", and the note went on to end it. The note now carries the original time (`__Host-lukk-logout` holds it; renewing the minute carries it forward and never walks it past a sign-in in flight), and a note written by an older release, which has no time in it, falls back to the previous behaviour.
- **A same-origin script could veto every logout.** `signedInSince` believed a sign-in record up to five seconds ahead of now, but lukk-js clamps everything it writes to the present — so that window only ever admitted a *forged* record. Anything on the origin could plant one on a timer and make every `logout()` stand down: local state cleared, the request never sent, the session live. There is no tolerance window now.
- **A note written before a backwards clock correction never aged out.** Its age was negative, so its minute never elapsed, while the equally-future sign-in record was disbelieved and nothing could stand it down — every page load for the next hour ended whatever session the tab held. A note dated in the future is now ignored outright.
- **Direct mode: a stood-down logout left the page reading as signed out** on the one restore branch that never cleared the flag. The session is live and already restored there, so only the flag was wrong; it self-healed on the next page load.
