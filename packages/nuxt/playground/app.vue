<script setup lang="ts">
const { user, loggedIn, login, logout, pendingTwoFactor, verifyTwoFactor } = useLukkAuth()

const email = ref('')
const password = ref('')
const code = ref('')
const message = ref('')

function errorMessage(e: unknown): string {
  return (e as { message?: string })?.message ?? 'Something went wrong'
}

async function onLogin() {
  message.value = ''
  try {
    await login({ email: email.value, password: password.value })
  }
  catch (e) {
    message.value = errorMessage(e)
  }
}

async function onVerify() {
  message.value = ''
  try {
    await verifyTwoFactor(code.value)
  }
  catch (e) {
    message.value = errorMessage(e)
  }
}
</script>

<template>
  <main style="font-family: sans-serif; max-width: 22rem; margin: 4rem auto;">
    <h1>lukk-nuxt playground</h1>

    <div v-if="loggedIn">
      <p>Logged in ✓</p>
      <pre>{{ user }}</pre>
      <button @click="logout()">
        Log out
      </button>
    </div>

    <form
      v-else-if="pendingTwoFactor"
      @submit.prevent="onVerify"
    >
      <p>Enter your two-factor code:</p>
      <input
        v-model="code"
        inputmode="numeric"
        autocomplete="one-time-code"
        placeholder="123456"
      >
      <button type="submit">
        Verify
      </button>
    </form>

    <form
      v-else
      @submit.prevent="onLogin"
    >
      <input
        v-model="email"
        type="email"
        placeholder="email"
        autocomplete="username"
      >
      <input
        v-model="password"
        type="password"
        placeholder="password"
        autocomplete="current-password"
      >
      <button type="submit">
        Log in
      </button>
    </form>

    <p v-if="message">
      {{ message }}
    </p>
  </main>
</template>
