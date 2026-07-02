<script setup lang="ts">
// Hydration marker for the E2E harness: onMounted only runs client-side after the
// app has hydrated, so tests can wait for [data-hydrated] before interacting — else
// they may fill inputs before v-model listeners attach and submit empty values.
onMounted(() => document.documentElement.setAttribute('data-hydrated', '1'))
</script>

<template>
  <div>
    <h1>lukk BFF + SSR E2E</h1>
    <nav>
      <NuxtLink to="/">Home</NuxtLink> |
      <NuxtLink to="/login">Login</NuxtLink> |
      <NuxtLink to="/dashboard">Dashboard</NuxtLink>
    </nav>
    <hr>
    <NuxtPage />
  </div>
</template>
