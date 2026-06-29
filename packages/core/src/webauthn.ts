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
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
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
    clientExtensionResults: credential.getClientExtensionResults(),
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
