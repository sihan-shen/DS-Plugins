import { createHmac } from 'node:crypto'
import type { RefV1 } from './contracts.js'

const MAX_IDENTIFIER_BYTES = 16 * 1_024
const encoder = new TextEncoder()

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function identityText(value: string, allowEmpty: boolean): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new TypeError('Invalid identity input')
  }
  if (!isWellFormedUnicode(value) || encoder.encode(value).byteLength > MAX_IDENTIFIER_BYTES) {
    throw new TypeError('Invalid identity input')
  }
  return value
}

export function pseudonym(salt: Uint8Array, domain: string, value: string): RefV1 {
  if (!(salt instanceof Uint8Array) || salt.byteLength !== 32) {
    throw new TypeError('Invalid identity input')
  }
  const parsedDomain = identityText(domain, false)
  const parsedValue = identityText(value, true)
  return createHmac('sha256', salt)
    .update(JSON.stringify([parsedDomain, parsedValue]))
    .digest('hex')
}
