// Test-only crypto for the conformance suite: a TOTP generator and a software
// WebAuthn authenticator, both built on node:crypto (no new dependencies). They
// let conformance COMPLETE the 2FA and passkey ceremonies against real lukk,
// not just assert the wire shapes. The output is shaped like a browser
// `PublicKeyCredential`, so lukk-core's real `credentialToJSON` serializes it.
import { createHash, createHmac, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'

// --- TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30s step) ---

function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(c)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function totp(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30)
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', base32Decode(secret)).update(msg).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const bin = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!
  return (bin % 1_000_000).toString().padStart(6, '0')
}

// --- minimal CBOR encoder (just what COSE keys + attestationObject need) ---

function head(major: number, n: number): Buffer {
  const mt = major << 5
  if (n < 24) return Buffer.from([mt | n])
  if (n < 0x100) return Buffer.from([mt | 24, n])
  if (n < 0x10000) {
    const b = Buffer.alloc(3)
    b[0] = mt | 25
    b.writeUInt16BE(n, 1)
    return b
  }
  const b = Buffer.alloc(5)
  b[0] = mt | 26
  b.writeUInt32BE(n, 1)
  return b
}

function cbor(value: unknown): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)])
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8')
    return Buffer.concat([head(3, b.length), b])
  }
  if (value instanceof Map) {
    const parts = [head(5, value.size)]
    for (const [k, v] of value) parts.push(cbor(k), cbor(v))
    return Buffer.concat(parts)
  }
  throw new Error('cbor: unsupported value')
}

const leftPad32 = (b: Buffer): Buffer => (b.length >= 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]))

interface CredentialOptions { challenge: string, user?: { id: string } }

/** A software WebAuthn authenticator: registers once, then asserts logins. */
export function createAuthenticator(rpId = 'localhost', origin = 'http://localhost:8000') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const credentialId = randomBytes(16)
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string, y: string }
  const x = leftPad32(Buffer.from(jwk.x, 'base64url'))
  const y = leftPad32(Buffer.from(jwk.y, 'base64url'))
  const rpIdHash = createHash('sha256').update(rpId).digest()
  let userHandle: Buffer | null = null

  function authData(flags: number, attested: boolean): Buffer {
    const parts = [rpIdHash, Buffer.from([flags]), Buffer.alloc(4)] // signCount 0 (synced-passkey safe)
    if (attested) {
      const cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]])
      const len = Buffer.alloc(2)
      len.writeUInt16BE(credentialId.length)
      parts.push(Buffer.alloc(16) /* aaguid */, len, credentialId, cbor(cose))
    }
    return Buffer.concat(parts)
  }

  const clientData = (type: string, challenge: string): Buffer =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8')

  const fake = (response: object): PublicKeyCredential => ({
    id: credentialId.toString('base64url'),
    type: 'public-key',
    rawId: credentialId,
    getClientExtensionResults: () => ({}),
    response,
  } as unknown as PublicKeyCredential)

  return {
    credentialId,
    /** Attestation (registration) ceremony. */
    create(options: CredentialOptions) {
      if (options.user) userHandle = Buffer.from(options.user.id, 'base64url')
      const attestationObject = cbor(new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData(0x45, true)], // UP | UV | AT
      ]))
      return fake({
        clientDataJSON: clientData('webauthn.create', options.challenge),
        attestationObject,
        getTransports: () => ['internal'],
      })
    },
    /** Assertion (login) ceremony. */
    get(options: CredentialOptions) {
      const ad = authData(0x05, false) // UP | UV
      const cdj = clientData('webauthn.get', options.challenge)
      const signature = createSign('SHA256')
        .update(Buffer.concat([ad, createHash('sha256').update(cdj).digest()]))
        .sign(privateKey)
      return fake({ clientDataJSON: cdj, authenticatorData: ad, signature, userHandle })
    },
  }
}
