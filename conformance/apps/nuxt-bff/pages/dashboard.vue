<script setup lang="ts">
// lukk-auth requires a session; an unauthenticated request is redirected to /login
// during SSR (server-side), so a logged-out user never sees this page's content.
definePageMeta({ middleware: 'lukk-auth' })

const { user, logout } = useLukkAuth()
const { confirmPassword } = useLukkConfirmation()
const { register } = useLukkPasskeys()
// `verified` is the composable's mode-agnostic helper (handles both the email_verified
// boolean and an email_verified_at timestamp), not the raw resource field.
const { sendVerificationEmail, verified } = useLukkEmailVerification()

const confirmPw = ref('')
const passkeyRegistered = ref(false)
const emailSent = ref(false)
const err = ref('')

async function doLogout() {
  await logout()
  await navigateTo('/login')
}

// The case the session specs are about: a logout the page does NOT await, followed at once by a
// full navigation — within this app, or away to another origin entirely.
function logoutAndLeave(to: string) {
  void logout().catch(() => {})
  window.location.href = to
}

// Passkey registration is gated by step-up confirmation: confirm the password first
// (the BFF holds the confirmation token server-side), then run the WebAuthn ceremony.
async function registerPasskey() {
  err.value = ''
  try {
    await confirmPassword(confirmPw.value)
    await register('E2E Key')
    passkeyRegistered.value = true
  }
  catch (e) {
    err.value = (e as { message?: string }).message ?? 'passkey registration failed'
  }
}

async function resendEmail() {
  err.value = ''
  try {
    await sendVerificationEmail()
    emailSent.value = true
  }
  catch (e) {
    err.value = (e as { message?: string }).message ?? 'could not send verification email'
  }
}
</script>

<template>
  <div>
    <h2>Dashboard (protected)</h2>
    <button
      data-testid="logout-navigate"
      @click="logoutAndLeave('/')"
    >
      Log out and go home
    </button>
    <button
      data-testid="logout-slow"
      @click="logoutAndLeave('/slow?ms=3000')"
    >
      Log out and go to a slow page
    </button>
    <button
      data-testid="logout-leave"
      @click="logoutAndLeave(String($route.query.away ?? '/'))"
    >
      Log out and leave
    </button>
    <p data-testid="user-email">
      {{ user?.email }}
    </p>
    <p data-testid="user-verified">
      {{ verified }}
    </p>
    <button
      data-testid="logout"
      @click="doLogout"
    >
      Log out
    </button>

    <section>
      <h3>Passkey</h3>
      <input
        v-model="confirmPw"
        data-testid="confirm-password"
        type="password"
        placeholder="confirm password"
      >
      <button
        data-testid="register-passkey"
        @click="registerPasskey"
      >
        Register passkey
      </button>
      <p
        v-if="passkeyRegistered"
        data-testid="passkey-registered"
      >
        passkey registered
      </p>
    </section>

    <section>
      <h3>Email verification</h3>
      <button
        data-testid="resend-email"
        @click="resendEmail"
      >
        Resend verification
      </button>
      <p
        v-if="emailSent"
        data-testid="email-sent"
      >
        verification email sent
      </p>
    </section>

    <p
      v-if="err"
      data-testid="dashboard-error"
    >
      {{ err }}
    </p>
  </div>
</template>
