---
"lukk-core": minor
---

**`LukkError` carries lukk's `reason`.** lukk answers a step-up confirmation that belongs to another session with 423 and `reason: "confirmation_session_mismatch"`, so a client can tell it from a missing confirmation without matching English text. The field was dropped; it is now passed through when it is a string.
