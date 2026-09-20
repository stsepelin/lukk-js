<script setup lang="ts">
// Redirects on the SERVER for a signed-out visitor — a response shape that never renders HTML.
const { loggedIn } = useLukkAuth()
if (import.meta.server && !loggedIn.value) await navigateTo('/login')
</script>

<template>
  <div>
    <h2>Redirect target</h2>
    <p data-testid="auth-state">
      {{ loggedIn ? 'authenticated' : 'guest' }}
    </p>
  </div>
</template>
