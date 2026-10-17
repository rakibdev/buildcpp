#!/usr/bin/env bun
import path from 'node:path'
import * as api from './api'
import { emptyCache, hasher, readCache, writeCache } from './cache'
import { resolve } from './resolve'
import { run } from './run'
import { scan } from './scan'
import { plan } from './steps'
import type { Config } from './types'

Bun.plugin({
  name: 'buildcpp',
  setup: build => build.module('buildcpp', () => ({ exports: api, loader: 'object' })),
})

const root = process.cwd()
const { default: config }: { default: Config } = await import(path.join(root, 'build.ts'))
const names = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const unknown = names.find(name => !config.targets[name])
if (unknown) throw new Error(`unknown target '${unknown}', expected one of: ${Object.keys(config.targets).join(', ')}`)

const all = Object.values(config.targets)
const targets = names.length ? names.map(name => config.targets[name]) : all
const modeDir = path.join(config.outDir ?? 'build', api.release ? 'release' : 'dev')
const cache = path.join(modeDir, '.cache')
const cacheFile = path.join(cache, 'cache.bin')

const previous = await readCache(cacheFile)
const next = emptyCache()
const hash = hasher(root, previous, next)
const { nodes, units } = await resolve(root, all, modeDir)
await scan(root, cache, units, previous, next, hash)
const targetNames = new Map(Object.entries(config.targets).map(([name, target]) => [target, name]))
const { steps, links } = await plan(root, cache, nodes, units, targetNames, hash)
const wanted = nodes.filter(node => targets.includes(node.target) && !node.target.prebuilt).map(node => links.get(node)!)
const save = () => writeCache(cacheFile, next)
try {
  process.exitCode = await run(root, steps, wanted, previous, next, save)
} finally {
  await save()
}
