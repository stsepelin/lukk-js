<script setup lang="ts">
definePageMeta({ middleware: 'lukk-auth' })

const { user, logout } = useLukkAuth()

async function doLogout() {
  await logout()
  await navigateTo('/login')
}

// A logout the page does NOT await, followed at once by a full navigation — the case the session
// spec is about (in direct mode the note names the session by the access token's family).
function logoutAndLeave(to: string) {
  void logout().catch(() => {})
  window.location.href = to
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
    <button
      data-testid="logout-navigate"
      @click="logoutAndLeave('/')"
    >
      Log out and go home
    </button>
    <button
      data-testid="logout-leave"
      @click="logoutAndLeave(String($route.query.away ?? '/'))"
    >
      Log out and leave
    </button>
  </div>
</template>
