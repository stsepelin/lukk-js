<script setup lang="ts">
definePageMeta({ middleware: 'lukk-guest' })

const { login, verifyTwoFactor, pendingTwoFactor } = useLukkAuth()
const email = ref('')
const password = ref('')
const code = ref('')
const error = ref('')

async function submit() {
  error.value = ''
  try {
    await login({ email: email.value, password: password.value })
    if (!pendingTwoFactor.value) await navigateTo('/dashboard')
  }
  catch (e) { error.value = (e as { message?: string }).message ?? 'login failed' }
}

async function submitCode() {
  error.value = ''
  try {
    await verifyTwoFactor(code.value)
    await navigateTo('/dashboard')
  }
  catch (e) { error.value = (e as { message?: string }).message ?? 'invalid code' }
}
</script>

<template>
  <div>
    <h2>Login</h2>
    <form
      v-if="!pendingTwoFactor"
      @submit.prevent="submit"
    >
      <input
        v-model="email"
        data-testid="email"
        type="email"
        placeholder="email"
      >
      <input
        v-model="password"
        data-testid="password"
        type="password"
        placeholder="password"
      >
      <button
        data-testid="submit"
        type="submit"
      >
        Log in
      </button>
    </form>
    <form
      v-else
      @submit.prevent="submitCode"
    >
      <p data-testid="two-factor-prompt">
        Enter your authenticator code
      </p>
      <input
        v-model="code"
        data-testid="totp-code"
        placeholder="123456"
      >
      <button
        data-testid="totp-submit"
        type="submit"
      >
        Verify
      </button>
    </form>
    <p
      v-if="error"
      data-testid="login-error"
    >
      {{ error }}
    </p>
  </div>
</template>
