import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
)

const publishedFiles = ['lib', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE']
const sourceFiles = ['cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE']

describe('published plugin contract', () => {
  it('declares an installable host bundle and web client', () => {
    expect(packageJson.name).toBe('dsh-air')
    expect(packageJson.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(packageJson.dsh?.client?.platform).toBe('web')
  })

  it('exposes the host and client entry points from lib', () => {
    expect(packageJson.main).toBe('lib/index.js')
    expect(packageJson.exports?.['.']?.default).toBe('./lib/index.js')
    expect(packageJson.exports?.['./client']?.default).toBe('./lib/client.js')
    expect(packageJson.exports?.['./client']?.types).toBe('./lib/types/client/index.d.ts')
  })

  it('keeps every package-file declaration needed by dsh plugin install', () => {
    for (const file of publishedFiles) expect(packageJson.files).toContain(file)
    for (const file of sourceFiles) {
      expect(existsSync(resolve(repositoryRoot, file))).toBe(true)
    }
  })

  it('points the bundle patch at the published plugin id', () => {
    const patch = readFileSync(resolve(repositoryRoot, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: air')
    expect(patch).toContain('name: dsh-air')
  })
})
