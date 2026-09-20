<script setup lang="ts">
// Hydration marker so E2E waits for v-model listeners before interacting.
onMounted(() => document.documentElement.setAttribute('data-hydrated', '1'))
</script>

<template>
  <div>
    <h1>lukk direct (SPA/SSG) E2E</h1>
    <nav>
      <NuxtLink to="/">Home</NuxtLink> |
      <NuxtLink to="/login">Login</NuxtLink> |
      <NuxtLink to="/dashboard">Dashboard</NuxtLink>
    </nav>
    <hr>
    <NuxtPage />
  </div>
</template>
