<script setup lang="ts">
// A page whose SERVER render takes a while (`?ms=`), so a test can land on it while
// something else — a sign-in in another tab — completes.
const route = useRoute()
const { loggedIn, user } = useLukkAuth()

await useAsyncData('slow', async () => {
  if (import.meta.server) await new Promise(resolve => setTimeout(resolve, Math.min(Number(route.query.ms ?? 0), 10_000)))
  return { slow: true }
})
</script>

<template>
  <div>
    <h2>Slow</h2>
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
