---
"lukk-nuxt": patch
---

**BFF: the auth proxy strips a credential from a passed-through body at any depth.**

The fail-closed deny-list that removes `access_token`, `refresh_token` and `confirmation_token` from a body the proxy returns stopped four levels down. A token nested any deeper, for example in a rebound response that wraps its payload in an envelope, reached the browser. That is the one thing BFF mode exists to prevent. The cap was there for cyclic bodies, but a parsed JSON body cannot be cyclic, and the work is linear in a body lukk already sent. lukk's own responses never nest a token that deep, so a stock install was not affected.
