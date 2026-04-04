const PBKDF2_FORMAT_PREFIX = "pbkdf2"
const PBKDF2_HASH_ALGORITHM = "sha256"
const PBKDF2_ITERATIONS = 210_000
const PBKDF2_SALT_BYTES = 16
const PBKDF2_HASH_BYTES = 32

function getCryptoApi() {
  const cryptoApi = globalThis.crypto

  if (!cryptoApi?.subtle) {
    throw new Error("Web Crypto API is not available in this runtime.")
  }

  return cryptoApi
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null
  }

  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=")

  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    return bytes
  } catch {
    return null
  }
}

async function deriveHash({
  plain,
  salt,
  iterations,
}: {
  plain: string
  salt: Uint8Array
  iterations: number
}): Promise<Uint8Array> {
  const cryptoApi = getCryptoApi()
  const keyMaterial = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(plain),
    "PBKDF2",
    false,
    ["deriveBits"]
  )

  const hashBuffer = await cryptoApi.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new Uint8Array(salt),
      iterations,
    },
    keyMaterial,
    PBKDF2_HASH_BYTES * 8
  )

  return new Uint8Array(hashBuffer)
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false
  }

  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }

  return mismatch === 0
}

export async function hashPassword(plain: string): Promise<string> {
  const cryptoApi = getCryptoApi()
  const salt = cryptoApi.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES))
  const hash = await deriveHash({
    plain,
    salt,
    iterations: PBKDF2_ITERATIONS,
  })

  return [
    PBKDF2_FORMAT_PREFIX,
    PBKDF2_HASH_ALGORITHM,
    String(PBKDF2_ITERATIONS),
    bytesToBase64Url(salt),
    bytesToBase64Url(hash),
  ].join("$")
}

export async function verifyPassword(plain: string, encoded: string): Promise<boolean> {
  const segments = encoded.split("$")
  if (segments.length !== 5) {
    return false
  }

  const [format, algorithm, iterationsRaw, saltRaw, hashRaw] = segments

  if (!format || !algorithm || !iterationsRaw || !saltRaw || !hashRaw) {
    return false
  }

  if (format !== PBKDF2_FORMAT_PREFIX || algorithm !== PBKDF2_HASH_ALGORITHM) {
    return false
  }

  const iterations = Number.parseInt(iterationsRaw, 10)
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false
  }

  const salt = base64UrlToBytes(saltRaw)
  const expectedHash = base64UrlToBytes(hashRaw)

  if (!salt || !expectedHash) {
    return false
  }

  if (salt.length !== PBKDF2_SALT_BYTES || expectedHash.length !== PBKDF2_HASH_BYTES) {
    return false
  }

  const candidateHash = await deriveHash({
    plain,
    salt,
    iterations,
  })

  return safeEqual(candidateHash, expectedHash)
}
