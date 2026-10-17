#!/usr/bin/env bun
import path from 'node:path'
import * as api from './api'
import { writeNinja } from './ninja'
import { resolve } from './resolve'
import { scan } from './scan'
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

const { nodes, units } = await resolve(root, all, modeDir)
await scan(root, cache, units)
const manifest = await writeNinja(root, cache, nodes, units)
Bun.spawnSync(['ninja', '-f', manifest, '-t', 'cleandead'], { cwd: root })
const outputs = nodes.filter(node => targets.includes(node.target) && !node.target.prebuilt).map(node => node.output)
const ninja = Bun.spawn(['ninja', '-f', manifest, ...outputs], { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] })
process.exitCode = await ninja.exited
