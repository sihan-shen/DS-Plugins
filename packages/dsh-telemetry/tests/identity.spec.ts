import { describe, expect, it } from 'vitest'
import { pseudonym } from '../src/identity.ts'

describe('pseudonym', () => {
  it('computes the canonical domain-separated HMAC-SHA256 reference', () => {
    const salt = new Uint8Array(32).fill(7)

    expect(pseudonym(salt, 'route', '["provider","model"]'))
      .toBe('c8dde9b276a5bbfa0d9dcbb5ddb767d3ccb207c0e421f7f7b172fae70a5c4b85')
  })

  it('changes references when either the private salt or identity domain changes', () => {
    const salt = new Uint8Array(32).fill(7)
    const baseline = pseudonym(salt, 'request', '同一个标识符')

    expect(pseudonym(new Uint8Array(32).fill(8), 'request', '同一个标识符')).not.toBe(baseline)
    expect(pseudonym(salt, 'node', '同一个标识符')).not.toBe(baseline)
  })

  it('rejects identifiers above 16 KiB before invoking crypto', () => {
    const salt = new Uint8Array(32).fill(7)

    expect(() => pseudonym(salt, 'request', '界'.repeat(5_462))).toThrow(TypeError)
    expect(() => pseudonym(salt, 'request', '界'.repeat(5_461))).not.toThrow()
  })

  it('rejects malformed identity inputs without including their values in errors', () => {
    const privateValue = `private-${'x'.repeat(20)}`

    for (const invoke of [
      () => pseudonym(new Uint8Array(31), 'request', privateValue),
      () => pseudonym(new Uint8Array(32), '', privateValue),
      () => pseudonym(new Uint8Array(32), 'request', '\ud800'),
    ]) {
      try {
        invoke()
        throw new Error('expected pseudonym to reject malformed input')
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError)
        expect(String(error)).not.toContain(privateValue)
      }
    }
  })

  it('does not mutate the salt', () => {
    const salt = new Uint8Array(32).fill(7)
    const before = salt.slice()

    pseudonym(salt, 'route', '["provider","model"]')

    expect(salt).toEqual(before)
  })
})
