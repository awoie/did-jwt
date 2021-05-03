import { XChaCha20Poly1305 } from '@stablelib/xchacha20poly1305'
import { generateKeyPair, sharedKey } from '@stablelib/x25519'
import { randomBytes } from '@stablelib/random'
import { concatKDF } from './Digest'
import { bytesToBase64url, base58ToBytes, encodeBase64url, toSealed, base64ToBytes, decodeBase64url } from './util'
import { Recipient, EncryptionResult, Encrypter, Decrypter } from './JWE'
import type { VerificationMethod, Resolvable } from 'did-resolver'
import { fromString } from 'uint8arrays'

// remove when targeting node 11+ or ES2019
const flatten = <T>(arrays: T[]) => [].concat.apply([], arrays)

function xc20pEncrypter(key: Uint8Array): (cleartext: Uint8Array, aad?: Uint8Array) => EncryptionResult {
  const cipher = new XChaCha20Poly1305(key)
  return (cleartext: Uint8Array, aad?: Uint8Array) => {
    const iv = randomBytes(cipher.nonceLength)
    const sealed = cipher.seal(iv, cleartext, aad)
    return {
      ciphertext: sealed.subarray(0, sealed.length - cipher.tagLength),
      tag: sealed.subarray(sealed.length - cipher.tagLength),
      iv
    }
  }
}

export function xc20pDirEncrypter(key: Uint8Array): Encrypter {
  const xc20pEncrypt = xc20pEncrypter(key)
  const enc = 'XC20P'
  const alg = 'dir'
  async function encrypt(cleartext, protectedHeader = {}, aad?): Promise<EncryptionResult> {
    const protHeader = encodeBase64url(JSON.stringify(Object.assign({ alg }, protectedHeader, { enc })))
    const encodedAad = new Uint8Array(Buffer.from(aad ? `${protHeader}.${bytesToBase64url(aad)}` : protHeader))
    return {
      ...xc20pEncrypt(cleartext, encodedAad),
      protectedHeader: protHeader
    }
  }
  return { alg, enc, encrypt }
}

export function xc20pDirDecrypter(key: Uint8Array): Decrypter {
  const cipher = new XChaCha20Poly1305(key)
  async function decrypt(sealed, iv, aad?): Promise<Uint8Array> {
    return cipher.open(iv, sealed, aad)
  }
  return { alg: 'dir', enc: 'XC20P', decrypt }
}

export function x25519Encrypter(publicKey: Uint8Array, kid?: string): Encrypter {
  const alg = 'ECDH-ES+XC20PKW'
  const keyLen = 256
  const crv = 'X25519'
  async function encryptCek(cek): Promise<Recipient> {
    const epk = generateKeyPair()
    const sharedSecret = sharedKey(epk.secretKey, publicKey)
    // Key Encryption Key
    const kek = concatKDF(sharedSecret, keyLen, alg)
    const res = xc20pEncrypter(kek)(cek)
    const recipient: Recipient = {
      encrypted_key: bytesToBase64url(res.ciphertext),
      header: {
        alg,
        iv: bytesToBase64url(res.iv),
        tag: bytesToBase64url(res.tag),
        epk: { kty: 'OKP', crv, x: bytesToBase64url(epk.publicKey) }
      }
    }
    if (kid) recipient.header.kid = kid
    return recipient
  }
  async function encrypt(cleartext, protectedHeader = {}, aad?): Promise<EncryptionResult> {
    // we won't want alg to be set to dir from xc20pDirEncrypter
    Object.assign(protectedHeader, { alg: undefined })
    // Content Encryption Key
    const cek = randomBytes(32)
    return {
      ...(await xc20pDirEncrypter(cek).encrypt(cleartext, protectedHeader, aad)),
      recipient: await encryptCek(cek),
      cek
    }
  }
  return { alg, enc: 'XC20P', encrypt, encryptCek }
}

export type X25519AuthEncryptParams = {
  kid?: string,
  skid?: string,
  apu?: string,
  apv?: string
}

export function x25519AuthEncrypter(recipientPublicKey: Uint8Array, senderSecretKey: Uint8Array, 
  options: Partial<X25519AuthEncryptParams> = {}): Encrypter {

  const alg = 'ECDH-1PU+XC20PKW'
  const keyLen = 256
  const crv = 'X25519'

  // It is RECOMMENDED by the ECDH-1PU spec to set apu and apv 
  // to base64url encoded kid and base64url encoded skid. If
  // not provided, PartyVInfo and PartyUInfo should contain
  // the base64url decoded skid/kid in case no apu/apv was provided.
  function setPartyInfo(partyInfo, fallback): { encoded: string, raw: Uint8Array } {
    if (typeof partyInfo === 'undefined') {
      return (typeof fallback !== 'undefined') ? 
        { encoded: encodeBase64url(fallback), raw: fromString(fallback) } :
         { encoded: undefined, raw: undefined }
    } else {
      return {
        encoded: encodeBase64url(partyInfo), raw: fromString(partyInfo)
      }
    }
  }
  const partyUInfo = setPartyInfo(options.apu, options.skid)
  const partyVInfo = setPartyInfo(options.apv, options.kid)

  async function encryptCek(cek): Promise<Recipient> {
    const epk = generateKeyPair()
    const zE = sharedKey(epk.secretKey, recipientPublicKey)

    // ECDH-1PU requires additional shared secret between 
    // static key of sender and static key of recipient
    const zS = sharedKey(senderSecretKey, recipientPublicKey)
    
    let sharedSecret = new Uint8Array(zE.length + zS.length);
    sharedSecret.set(zE);
    sharedSecret.set(zS, zE.length);

    // Key Encryption Key
    const kek = concatKDF(sharedSecret, keyLen, alg, partyUInfo.raw, partyVInfo.raw)

    const res = xc20pEncrypter(kek)(cek)
    const recipient: Recipient = {
      encrypted_key: bytesToBase64url(res.ciphertext),
      header: {
        alg,
        iv: bytesToBase64url(res.iv),
        tag: bytesToBase64url(res.tag),
        epk: { kty: 'OKP', crv, x: bytesToBase64url(epk.publicKey) }
      }
    }
    if (typeof options.kid !== 'undefined') recipient.header.kid = options.kid
    if (typeof partyUInfo.encoded !== 'undefined') recipient.header.apu = partyUInfo.encoded
    if (typeof partyVInfo.encoded !== 'undefined') recipient.header.apv = partyVInfo.encoded

    return recipient
  }
  async function encrypt(cleartext, protectedHeader = {}, aad?): Promise<EncryptionResult> {
    // we won't want alg to be set to dir from xc20pDirEncrypter
    Object.assign(protectedHeader, { alg: undefined, skid: options.skid })
    // Content Encryption Key
    const cek = randomBytes(32)
    return {
      ...(await xc20pDirEncrypter(cek).encrypt(cleartext, protectedHeader, aad)),
      recipient: await encryptCek(cek),
      cek
    }
  }
  return { alg, enc: 'XC20P', encrypt, encryptCek }
}

export async function resolveX25519Encrypters(dids: string[], resolver: Resolvable): Promise<Encrypter[]> {
  const encryptersForDID = async (did): Promise<Encrypter[]> => {
    const { didResolutionMetadata, didDocument } = await resolver.resolve(did)
    if (didResolutionMetadata?.error) {
      throw new Error(
        `Could not find x25519 key for ${did}: ${didResolutionMetadata.error}, ${didResolutionMetadata.message}`
      )
    }
    if (!didDocument.keyAgreement) throw new Error(`Could not find x25519 key for ${did}`)
    const agreementKeys: VerificationMethod[] = didDocument.keyAgreement?.map((key) => {
      if (typeof key === 'string') {
        return [...(didDocument.publicKey || []), ...(didDocument.verificationMethod || [])].find((pk) => pk.id === key)
      }
      return key
    })
    const pks = agreementKeys.filter((key) => {
      return key.type === 'X25519KeyAgreementKey2019' && Boolean(key.publicKeyBase58)
    })
    if (!pks.length) throw new Error(`Could not find x25519 key for ${did}`)
    return pks.map((pk) => x25519Encrypter(base58ToBytes(pk.publicKeyBase58), pk.id))
  }

  const encrypterPromises = dids.map((did) => encryptersForDID(did))
  const encrypterArrays = await Promise.all(encrypterPromises)

  return flatten(encrypterArrays)
}

function validateHeader(header: Record<string, any>) {
  if (!(header.epk && header.iv && header.tag)) {
    throw new Error('Invalid JWE')
  }
}

export function x25519Decrypter(secretKey: Uint8Array): Decrypter {
  const alg = 'ECDH-ES+XC20PKW'
  const keyLen = 256
  const crv = 'X25519'
  async function decrypt(sealed, iv, aad, recipient): Promise<Uint8Array> {
    validateHeader(recipient.header)
    if (recipient.header.epk.crv !== crv) return null
    const publicKey = base64ToBytes(recipient.header.epk.x)
    const sharedSecret = sharedKey(secretKey, publicKey)

    // Key Encryption Key
    const kek = concatKDF(sharedSecret, keyLen, alg)
    // Content Encryption Key
    const sealedCek = toSealed(recipient.encrypted_key, recipient.header.tag)
    const cek = await xc20pDirDecrypter(kek).decrypt(sealedCek, base64ToBytes(recipient.header.iv))
    if (cek === null) return null

    return xc20pDirDecrypter(cek).decrypt(sealed, iv, aad)
  }
  return { alg, enc: 'XC20P', decrypt }
}

export function x25519AuthDecrypter(recipientSecretKey: Uint8Array, senderPublicKey: Uint8Array): Decrypter {
  const alg = 'ECDH-1PU+XC20PKW'
  const keyLen = 256
  const crv = 'X25519'
  async function decrypt(sealed, iv, aad, recipient): Promise<Uint8Array> {
    validateHeader(recipient.header)
    if (recipient.header.epk.crv !== crv) return null
    // ECDH-1PU requires additional shared secret between 
    // static key of sender and static key of recipient
    const publicKey = base64ToBytes(recipient.header.epk.x)
    const zE = sharedKey(recipientSecretKey, publicKey)
    const zS = sharedKey(recipientSecretKey, senderPublicKey)
    
    let sharedSecret = new Uint8Array(zE.length + zS.length);
    sharedSecret.set(zE);
    sharedSecret.set(zS, zE.length);

    // Key Encryption Key
    let producerInfo, consumerInfo
    if (recipient.header.apu) producerInfo = fromString(decodeBase64url(recipient.header.apu))
    if (recipient.header.apv) consumerInfo = fromString(decodeBase64url(recipient.header.apv))    

    const kek = concatKDF(sharedSecret, keyLen, alg, producerInfo, consumerInfo)
    // Content Encryption Key
    const sealedCek = toSealed(recipient.encrypted_key, recipient.header.tag)
    const cek = await xc20pDirDecrypter(kek).decrypt(sealedCek, base64ToBytes(recipient.header.iv))
    if (cek === null) return null

    return xc20pDirDecrypter(cek).decrypt(sealed, iv, aad)
  }
  return { alg, enc: 'XC20P', decrypt }
}