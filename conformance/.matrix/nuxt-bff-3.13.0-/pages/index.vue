<script setup lang="ts">
// Reads the auth state that SSR seeded (BFF hydration) — so this renders correctly
// on the first paint, which the E2E asserts against the raw server HTML.
const { loggedIn, user } = useLukkAuth()
</script>

<template>
  <div>
    <h2>Home</h2>
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
