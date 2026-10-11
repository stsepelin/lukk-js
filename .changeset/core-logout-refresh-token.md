---
"lukk-core": minor
---

**`logout({ refreshToken })` presents the refresh token.** lukk ends a session by the refresh token the client holds (the RFC 7009 shape), so a body-mode client whose access token has expired can log out without spending a rotation first — or while refreshing is throttled or failing. Older lukk releases ignore it and use the bearer.

**`forgotPassword`, `resetPassword`, `changePassword` and `sendEmailVerification` resolve to `LukkStatus`** (`{ status: string }`), the acknowledgement lukk answers them with, instead of `void`.
