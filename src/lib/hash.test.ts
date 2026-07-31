import { describe, expect, it } from 'vitest'
import { sha256Hex } from './hash'

describe('sha256Hex', () => {
  it('matches the published digest for the empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('matches the published digest for "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('handles input spanning multiple 64-byte blocks', () => {
    // 56 bytes forces an extra padding block, the classic off-by-one case.
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('is deterministic and collision-free for near-identical text', () => {
    const a = sha256Hex('Person with a gun at the Stafford Costco')
    const b = sha256Hex('Person with a gun at the Stafford Costco.')
    expect(a).toBe(sha256Hex('Person with a gun at the Stafford Costco'))
    expect(a).not.toBe(b)
    expect(a).toHaveLength(64)
  })
})
