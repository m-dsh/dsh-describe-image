import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('插件 manifest', () => {
  it('保持包名、bundle patch 和 Client 入口一致', () => {
    const root = resolve(import.meta.dirname, '..')
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const patch = readFileSync(resolve(root, manifest.dsh.bundle.patch), 'utf8')
    expect(manifest.name).toBe('dsh-describe-image')
    expect(patch).toContain(`name: '${manifest.name}'`)
    if (manifest.dsh?.client) {
      expect(manifest.exports['./client']?.default).toBe('./lib/client.js')
    } else {
      expect(manifest.exports['./client']).toBeUndefined()
    }
  })
})
