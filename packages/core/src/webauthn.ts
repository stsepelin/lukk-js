/**
 * Browser WebAuthn ⇄ lukk JSON plumbing.
 *
 * lukk speaks **base64url without padding** for challenges and credential ids;
 * the browser `navigator.credentials` API speaks `ArrayBuffer`. These helpers
 * translate both ways.
 */
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from './types'

export function base64urlToBuffer(value: string): ArrayBuffer {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4))
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const bytes = new Uint8Array(binary.length)
  // Stryker disable next-line EqualityOperator: `i <= binary.length` cannot be observed — the extra pass writes `charCodeAt(len)` (NaN) to an out-of-range index of an exactly-sized Uint8Array, which is a spec-level no-op even in strict mode.
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  // Stryker disable next-line Regex: dropping the `$` cannot be observed — `btoa` emits `=` only as trailing padding and neither preceding replacement can introduce one, so `/=+/` matches the same run.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** JSON registration options (from lukk) → `navigator.credentials.create()` input. */
export function toCreationOptions(json: PublicKeyCredentialCreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    challenge: base64urlToBuffer(json.challenge),
    rp: json.rp,
    user: { ...json.user, id: base64urlToBuffer(json.user.id) },
    pubKeyCredParams: json.pubKeyCredParams,
    ...(json.timeout != null ? { timeout: json.timeout } : {}),
    ...(json.attestation ? { attestation: json.attestation as AttestationConveyancePreference } : {}),
    ...(json.authenticatorSelection ? { authenticatorSelection: json.authenticatorSelection } : {}),
    excludeCredentials: (json.excludeCredentials ?? []).map(descriptorFromJSON),
  }
}

/** JSON assertion options (from lukk) → `navigator.credentials.get()` input. */
export function toRequestOptions(json: PublicKeyCredentialRequestOptionsJSON): PublicKeyCredentialRequestOptions {
  return {
    challenge: base64urlToBuffer(json.challenge),
    ...(json.rpId ? { rpId: json.rpId } : {}),
    ...(json.timeout != null ? { timeout: json.timeout } : {}),
    ...(json.userVerification ? { userVerification: json.userVerification } : {}),
    allowCredentials: (json.allowCredentials ?? []).map(descriptorFromJSON),
  }
}

/** A `PublicKeyCredential` from create()/get() → JSON for posting to lukk. */
export function credentialToJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response
  const base: Record<string, unknown> = {
    id: credential.id,
    type: credential.type,
    rawId: bufferToBase64url(credential.rawId),
    clientExtensionResults: buffersToBase64url(withoutSecrets(credential.getClientExtensionResults())),
    // Which kind of authenticator answered ("platform" or "cross-platform"), where the browser says —
    // as `PublicKeyCredential.toJSON()` reports it (WebAuthn L3 §5.1). Left out, not `null`, where it
    // does not: a server that validates the member's type would refuse `null`.
    ...(typeof credential.authenticatorAttachment === 'string' ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
  }

  if (isAttestation(response)) {
    base.response = {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
      attestationObject: bufferToBase64url(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    }
  }
  else {
    const assertion = response as AuthenticatorAssertionResponse
    base.response = {
      clientDataJSON: bufferToBase64url(assertion.clientDataJSON),
      authenticatorData: bufferToBase64url(assertion.authenticatorData),
      signature: bufferToBase64url(assertion.signature),
      userHandle: assertion.userHandle ? bufferToBase64url(assertion.userHandle) : null,
    }
  }
  return base
}

/**
 * Extension results without the two members that are secrets meant for the PAGE, not for a server.
 *
 * `prf.results` is key material the authenticator derives for this site — what an app encrypts the
 * visitor's data with — and `largeBlob.blob` is whatever the app stored on the authenticator. lukk reads
 * neither (it reads no extension result at all), so posting them would only put them where a request
 * body goes: a proxy hop, an access log, an APM trace. That they used to leave as `{}` was an accident
 * of `JSON.stringify`; that they stay behind is now on purpose. Everything else about both extensions
 * is kept (`prf.enabled`, `largeBlob.supported`, `largeBlob.written`). An app that does want either on
 * its own server reads it from the credential and sends it itself.
 */
function withoutSecrets(results: AuthenticationExtensionsClientOutputs): Record<string, unknown> {
  const { prf, largeBlob, ...rest } = results as Record<string, unknown> & { prf?: Record<string, unknown>, largeBlob?: Record<string, unknown> }
  return {
    ...rest,
    ...(prf === undefined ? {} : { prf: without(prf, 'results') }),
    ...(largeBlob === undefined ? {} : { largeBlob: without(largeBlob, 'blob') }),
  }
}

/** `value` without `member`, where it is an object that could have one; anything else as it is. */
function without(value: unknown, member: string): unknown {
  if (value === null || typeof value !== 'object') return value
  const { [member]: _dropped, ...kept } = value as Record<string, unknown>
  return kept
}

/**
 * Extension results as JSON: every buffer, at any depth, as base64url — what `toJSON()` does for them.
 *
 * Most results are plain data (`credProps.rk`), but some carry `ArrayBuffer`s, and `JSON.stringify`
 * writes one of those as `{}`: the bytes were silently dropped on the way to the server. By tag, not
 * `instanceof`: a buffer from another realm (an iframe, a browser extension's polyfill) is not an
 * instance of this realm's `ArrayBuffer`.
 */
function buffersToBase64url(value: unknown): unknown {
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return bufferToBase64url(value as ArrayBuffer)
  if (ArrayBuffer.isView(value)) return bufferToBase64url(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer)
  if (Array.isArray(value)) return value.map(buffersToBase64url)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, buffersToBase64url(member)]))
  }
  return value
}

function descriptorFromJSON(d: { type: 'public-key', id: string, transports?: string[] }): PublicKeyCredentialDescriptor {
  return {
    type: d.type,
    id: base64urlToBuffer(d.id),
    ...(d.transports ? { transports: d.transports as AuthenticatorTransport[] } : {}),
  }
}

function isAttestation(r: AuthenticatorResponse): r is AuthenticatorAttestationResponse {
  return 'attestationObject' in r
}
