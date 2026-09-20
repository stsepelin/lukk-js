<script setup lang="ts">
// Served through a `swr` route rule (see nuxt.config): its HTML is stored and replayed to whoever
// asks next, so nothing per-visitor may leak into it.
const { loggedIn, user } = useLukkAuth()
</script>

<template>
  <div>
    <h2>Cached</h2>
    <p data-testid="auth-state">
      {{ loggedIn ? 'authenticated' : 'guest' }}
    </p>
    <p
      v-if="user"
      data-testid="user-email"
    >
      {{ user.email }}
    </p>
  </div>
</template>
