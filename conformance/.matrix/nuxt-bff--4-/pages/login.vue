<script setup lang="ts">
// lukk-guest bounces an already-authenticated user away from /login.
definePageMeta({ middleware: 'lukk-guest' })

const { login, verifyTwoFactor, pendingTwoFactor } = useLukkAuth()
const { login: passkeyLogin } = useLukkPasskeys()

const email = ref('')
const password = ref('')
const code = ref('')
const error = ref('')

async function submitPasskey() {
  error.value = ''
  try {
    await passkeyLogin()
    await navigateTo('/dashboard')
  }
  catch (e) {
    error.value = (e as { message?: string }).message ?? 'passkey login failed'
  }
}

async function submit() {
  error.value = ''
  try {
    await login({ email: email.value, password: password.value })
    // 2FA users get a challenge instead of a session — the TOTP form shows below.
    if (!pendingTwoFactor.value) await navigateTo('/dashboard')
  }
  catch (e) {
    error.value = (e as { message?: string }).message ?? 'login failed'
  }
}

async function submitCode() {
  error.value = ''
  try {
    await verifyTwoFactor(code.value)
    await navigateTo('/dashboard')
  }
  catch (e) {
    error.value = (e as { message?: string }).message ?? 'invalid code'
  }
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

    <button
      v-if="!pendingTwoFactor"
      data-testid="passkey-login"
      @click="submitPasskey"
    >
      Sign in with a passkey
    </button>

    <p
      v-if="error"
      data-testid="login-error"
    >
      {{ error }}
    </p>
  </div>
</template>
