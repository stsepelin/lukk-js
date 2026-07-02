<script setup lang="ts">
// Landing page the signed verification link redirects to (?verified=1). Reload the
// user so the verified state reflects the just-completed verification.
const { verified, syncAfterVerify } = useLukkEmailVerification()
onMounted(syncAfterVerify)
</script>

<template>
  <div>
    <h2>Email verification</h2>
    <p data-testid="verified-state">
      {{ verified ? 'verified' : 'not verified' }}
    </p>
  </div>
</template>
