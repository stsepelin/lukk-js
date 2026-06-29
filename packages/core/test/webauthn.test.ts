import { describe, expect, it } from 'vitest'
import {
  base64urlToBuffer,
  bufferToBase64url,
  credentialToJSON,
  toCreationOptions,
  toRequestOptions,
} from '../src/webauthn'

const buf = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer

describe('base64url', () => {
  it('round-trips bytes, unpadded and url-safe', () => {
    const original = new Uint8Array([0, 1, 2, 62, 63, 250, 255]).buffer
    const encoded = bufferToBase64url(original)
    expect(encoded).not.toContain('=')
    expect(encoded).not.toMatch(/[+/]/)
    expect(new Uint8Array(base64urlToBuffer(encoded))).toEqual(new Uint8Array(original))
  })

  it('decodes padded (len % 4 !== 0) and unpadded (len % 4 === 0) values', () => {
    expect(new TextDecoder().decode(base64urlToBuffer('aGVsbG8'))).toBe('hello') // len 7 → needs pad
    expect(new TextDecoder().decode(base64urlToBuffer('YWJj'))).toBe('abc') // len 4 → no pad
  })
})

describe('toCreationOptions', () => {
  it('maps every field when present', () => {
    const opts = toCreationOptions({
      challenge: 'aGVsbG8',
      rp: { id: 'example.com', name: 'Example' },
      user: { id: 'dXNlcg', name: 'u', displayName: 'U' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      excludeCredentials: [
        { type: 'public-key', id: 'YQ', transports: ['internal'] },
        { type: 'public-key', id: 'Yg' },
      ],
      authenticatorSelection: { userVerification: 'required' },
      timeout: 60000,
      attestation: 'none',
    })

    expect(opts.challenge).toBeInstanceOf(ArrayBuffer)
    expect(opts.user.id).toBeInstanceOf(ArrayBuffer)
    expect(opts.timeout).toBe(60000)
    expect(opts.attestation).toBe('none')
    expect(opts.authenticatorSelection).toEqual({ userVerification: 'required' })
    expect(opts.excludeCredentials).toHaveLength(2)
    expect(opts.excludeCredentials![0]!.transports).toEqual(['internal'])
    expect(opts.excludeCredentials![1]!.transports).toBeUndefined()
  })

  it('omits optional fields when absent', () => {
    const opts = toCreationOptions({
      challenge: 'aGVsbG8',
      rp: { name: 'Example' },
      user: { id: 'dXNlcg', name: 'u', displayName: 'U' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    })

    expect(opts.timeout).toBeUndefined()
    expect(opts.attestation).toBeUndefined()
    expect(opts.authenticatorSelection).toBeUndefined()
    expect(opts.excludeCredentials).toEqual([])
  })
})

describe('toRequestOptions', () => {
  it('maps every field, and omits when absent', () => {
    const full = toRequestOptions({
      challenge: 'aGVsbG8',
      rpId: 'example.com',
      allowCredentials: [{ type: 'public-key', id: 'YQ', transports: ['usb'] }],
      userVerification: 'preferred',
      timeout: 1000,
    })
    expect(full.rpId).toBe('example.com')
    expect(full.timeout).toBe(1000)
    expect(full.userVerification).toBe('preferred')
    expect(full.allowCredentials).toHaveLength(1)

    const min = toRequestOptions({ challenge: 'aGVsbG8' })
    expect(min.rpId).toBeUndefined()
    expect(min.allowCredentials).toEqual([])
  })
})

describe('credentialToJSON', () => {
  it('serializes an attestation (registration) response', () => {
    const credential = {
      id: 'cred-id',
      type: 'public-key',
      rawId: buf('rawid'),
      getClientExtensionResults: () => ({}),
      response: { clientDataJSON: buf('cdj'), attestationObject: buf('att'), getTransports: () => ['internal'] },
    } as unknown as PublicKeyCredential

    const j = credentialToJSON(credential) as { id: string, response: Record<string, unknown> }
    expect(j.id).toBe('cred-id')
    expect(typeof j.response.attestationObject).toBe('string')
    expect(j.response.transports).toEqual(['internal'])
  })

  it('defaults transports to [] when getTransports is missing', () => {
    const credential = {
      id: 'c',
      type: 'public-key',
      rawId: buf('r'),
      getClientExtensionResults: () => ({}),
      response: { clientDataJSON: buf('c'), attestationObject: buf('a') },
    } as unknown as PublicKeyCredential

    expect((credentialToJSON(credential).response as { transports: string[] }).transports).toEqual([])
  })

  it('serializes an assertion (login) response with userHandle present and null', () => {
    const make = (userHandle: ArrayBuffer | null) => ({
      id: 'c',
      type: 'public-key',
      rawId: buf('r'),
      getClientExtensionResults: () => ({}),
      response: { clientDataJSON: buf('c'), authenticatorData: buf('a'), signature: buf('s'), userHandle },
    } as unknown as PublicKeyCredential)

    expect(typeof (credentialToJSON(make(buf('uh'))).response as { userHandle: unknown }).userHandle).toBe('string')
    expect((credentialToJSON(make(null)).response as { userHandle: unknown }).userHandle).toBeNull()
  })
})
