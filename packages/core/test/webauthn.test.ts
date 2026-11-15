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

  it('substitutes the url-safe alphabet in both directions', () => {
    // '-' and '_' stand in for base64's '+' and '/', and neither is reachable from friendly
    // bytes: [0xfb, 0xff] is the shortest input that produces both. A round-trip that never
    // hits those two characters cannot notice a dropped substitution — which would then
    // corrupt only the occasional challenge or signature whose bytes happen to land there.
    expect(bufferToBase64url(new Uint8Array([0xFB, 0xFF]).buffer)).toBe('-_8')
    expect(new Uint8Array(base64urlToBuffer('-_8'))).toEqual(new Uint8Array([0xFB, 0xFF]))
  })

  it('tops the padding back up rather than trusting the host decoder', () => {
    // lukk emits unpadded base64url, so the pad is defensive — but it is not decoration.
    // `atob` is forgiving about a *wholly* unpadded value and strict about a half-padded one
    // ('YWJjZA' and 'YWJjZA==' both decode; 'YWJjZA=' throws), so restoring the length to a
    // multiple of four is what makes a value from a producer that stripped only one '='
    // decode at all instead of throwing at the caller.
    expect(new TextDecoder().decode(base64urlToBuffer('YWJjZA='))).toBe('abcd')
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
    // Reading `undefined` back proves nothing: a spread of `{ timeout: undefined }` and a
    // spread of `{}` are indistinguishable that way, and only the second is "absent". The
    // distinction is the point of the conditional spreads — pin the exact key set.
    expect(Object.keys(opts).sort()).toEqual(['challenge', 'excludeCredentials', 'pubKeyCredParams', 'rp', 'user'])
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
    // Same reason as the creation side: an omitted option must be an absent key, not a
    // present key holding `undefined`.
    expect(Object.keys(min).sort()).toEqual(['allowCredentials', 'challenge'])
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

  it('says which kind of authenticator answered, where the browser does', () => {
    const make = (authenticatorAttachment?: string | null) => ({
      id: 'c',
      type: 'public-key',
      rawId: buf('r'),
      ...(authenticatorAttachment === undefined ? {} : { authenticatorAttachment }),
      getClientExtensionResults: () => ({}),
      response: { clientDataJSON: buf('c'), attestationObject: buf('a') },
    } as unknown as PublicKeyCredential)

    expect(credentialToJSON(make('platform')).authenticatorAttachment).toBe('platform')
    // Absent, not `null`: both where the browser reports null and where it has no such member at all.
    expect('authenticatorAttachment' in credentialToJSON(make(null))).toBe(false)
    expect('authenticatorAttachment' in credentialToJSON(make())).toBe(false)
  })

  it('writes the buffers in extension results as base64url, at any depth, and leaves the rest alone', () => {
    // JSON.stringify writes an ArrayBuffer as `{}`.
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252])
    // A view onto the middle of a larger buffer: only its own bytes, not the whole buffer's.
    const view = new Uint8Array(new Uint8Array([9, 9, 1, 2, 3, 9]).buffer, 2, 3)
    const credential = {
      id: 'c',
      type: 'public-key',
      rawId: buf('r'),
      getClientExtensionResults: () => ({
        credProps: { rk: true },
        some: { nested: { bytes: bytes.buffer, view } },
        list: [bytes.buffer, 'text', 7, null],
        nothing: null,
      }),
      response: { clientDataJSON: buf('c'), attestationObject: buf('a') },
    } as unknown as PublicKeyCredential

    const json = credentialToJSON(credential)

    expect(json.clientExtensionResults).toEqual({
      credProps: { rk: true },
      some: { nested: { bytes: 'AQID-vv8', view: 'AQID' } },
      list: ['AQID-vv8', 'text', 7, null],
      nothing: null,
    })
    // What reaches the server is what was read here: nothing left for JSON.stringify to flatten.
    expect(JSON.parse(JSON.stringify(json)).clientExtensionResults).toEqual(json.clientExtensionResults)
  })

  it('keeps the page\'s secrets on the page: PRF output and the large blob are not posted', () => {
    // `prf.results` is key material derived for this site, and `largeBlob.blob` what the app stored on
    // the authenticator. lukk reads neither; sent, they would sit in a request body.
    const secret = new Uint8Array([7, 7, 7]).buffer
    const make = (results: unknown) => ({
      id: 'c',
      type: 'public-key',
      rawId: buf('r'),
      getClientExtensionResults: () => results,
      response: { clientDataJSON: buf('c'), attestationObject: buf('a') },
    } as unknown as PublicKeyCredential)

    const sent = credentialToJSON(make({
      credProps: { rk: true },
      prf: { enabled: true, results: { first: secret, second: secret } },
      largeBlob: { supported: true, written: false, blob: secret },
    })).clientExtensionResults

    // Everything else about both extensions is kept.
    expect(sent).toEqual({ credProps: { rk: true }, prf: { enabled: true }, largeBlob: { supported: true, written: false } })
    expect(JSON.stringify(sent)).not.toContain('BwcH') // the three bytes, as base64url

    // Neither member is made up where the extension was not used, nor where a browser reports it oddly.
    // Strictly: not even as a member holding `undefined`.
    expect(credentialToJSON(make({ credProps: { rk: true } })).clientExtensionResults).toStrictEqual({ credProps: { rk: true } })
    expect(credentialToJSON(make({ prf: null, largeBlob: true })).clientExtensionResults).toEqual({ prf: null, largeBlob: true })
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
