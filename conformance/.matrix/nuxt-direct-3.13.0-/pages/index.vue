<script setup lang="ts">
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
