---
"lukk-nuxt": patch
---

**`session.maxAge` is validated.** It must be a positive whole number of seconds. `0` sealed every session with no expiry at all (iron reads a ttl of `0` as "never"), and a negative, fractional or non-numeric value wrote a cookie browsers drop or ignore. The build now fails with a message naming the option, and a runtime override that is not usable makes the session writers throw rather than seal anything weaker.
