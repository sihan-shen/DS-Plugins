import { canonicalGovernanceJson } from './canonical.js'

const MAX_CANONICAL_BYTES = 16_777_216
const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

function fail(code: 'byte-length' | 'utf8' | 'json' | 'canonical' | 'non-canonical bytes'): never {
  throw new TypeError(`governance admission ${code}`)
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function parseCanonicalGovernanceJson(input: Uint8Array): unknown {
  if (!(input instanceof Uint8Array) || input.byteLength > MAX_CANONICAL_BYTES) {
    fail('byte-length')
  }

  let source: string
  try {
    source = decoder.decode(input)
  } catch {
    fail('utf8')
  }

  let value: unknown
  try {
    value = JSON.parse(source) as unknown
  } catch {
    fail('json')
  }

  let canonical: string
  try {
    canonical = canonicalGovernanceJson(value)
  } catch {
    fail('canonical')
  }

  if (!equalBytes(input, encoder.encode(canonical))) fail('non-canonical bytes')
  return value
}
