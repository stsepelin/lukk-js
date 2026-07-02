<script setup lang="ts">
definePageMeta({ middleware: 'lukk-auth' })

const { user, logout } = useLukkAuth()

async function doLogout() {
  await logout()
  await navigateTo('/login')
}
</script>

<template>
  <div>
    <h2>Dashboard (protected)</h2>
    <p data-testid="user-email">
      {{ user?.email }}
    </p>
    <button
      data-testid="logout"
      @click="doLogout"
    >
      Log out
    </button>
  </div>
</template>
