import { Glob, $ } from 'bun'
import path from 'node:path'
import { release } from './api'
import { stdSource } from './std'
import type { Target } from './types'

export type Unit = {
  file: string
  flags: string[]
  hash: string
  node: Node
  bmiOnly: boolean
  provides?: string
  requires: string[]
}

export type Node = {
  target: Target
  packages: string[]
  flags: string[]
  links: string[]
  units: Unit[]
  imports: Unit[]
  std?: Unit
  deps: Node[]
  output: string
}

const stdWarnings = ['-Wno-reserved-module-identifier', '-Wno-include-angled-in-module-purview', '-Wno-deprecated-declarations']

const split = (text: string) => text.trim().split(/\s+/).filter(Boolean)

const packageCache = new Map<string, { cflags: string[]; libs: string[] }>()

const pkgConfig = async (packages: string[]) => {
  const key = packages.join(' ')
  const cached = packageCache.get(key)
  if (cached) return cached
  const result = packages.length
    ? { cflags: split(await $`pkg-config --cflags ${packages}`.text()), libs: split(await $`pkg-config --libs ${packages}`.text()) }
    : { cflags: [], libs: [] }
  packageCache.set(key, result)
  return result
}

const local = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return relative.startsWith('..') ? file : relative
}

const expand = async (root: string, patterns: string[]) => {
  const files = new Set<string>()
  for (const pattern of patterns) {
    const absolute = path.isAbsolute(pattern)
    const glob = new Glob(absolute ? path.relative('/', pattern) : pattern)
    for await (const file of glob.scan({ cwd: absolute ? '/' : root, absolute: true })) files.add(local(root, file))
  }
  return [...files].sort()
}

export const unitPath = (cache: string, unit: Pick<Unit, 'hash' | 'file'>, folder: string, suffix = '') =>
  path.join(cache, unit.hash, folder, (path.isAbsolute(unit.file) ? `external${unit.file}` : unit.file) + suffix)

const languageFlags = (flags: string[]) => flags.filter(flag => !/^-[DIU]/.test(flag))
const sourceFlags = (flags: string[]) => flags.filter(flag => /^-[DIU]/.test(flag))

const hashFlags = (flags: string[]) => Bun.hash(flags.join('\0')).toString(16).padStart(8, '0').slice(0, 8)

const defineFlags = (defines: Record<string, string | true>) =>
  Object.entries(defines).map(([name, value]) => typeof value == 'string' ? `-D${name}=${JSON.stringify(value)}` : `-D${name}`)

export const resolve = async (root: string, roots: Target[], modeDir: string) => {
  const nodes = new Map<Target, Node>()
  const units = new Map<string, Unit>()
  const std = await stdSource()

  const unit = (file: string, flags: string[], node: Node, bmiOnly: boolean) => {
    const hash = hashFlags(flags)
    const key = `${hash}:${file}`
    const existing = units.get(key)
    if (existing) return existing
    const created: Unit = { file, flags, hash, node, bmiOnly, requires: [] }
    units.set(key, created)
    return created
  }

  const visit = async (target: Target): Promise<Node> => {
    const existing = nodes.get(target)
    if (existing) return existing
    const deps = new Set<Node>()
    for (const dep of target.deps ?? []) {
      if (typeof dep == 'string') continue
      const node = await visit(dep)
      for (const nested of [...node.deps, node]) deps.add(nested)
    }
    const own = (target.deps ?? []).filter(dep => typeof dep == 'string')
    const packages = [...new Set([...own, ...[...deps].flatMap(dep => dep.packages)])]
    const { cflags, libs } = await pkgConfig(packages)
    const flags = [
      `-std=${target.std ?? 'c++26'}`,
      '-fPIC',
      ...(release ? ['-O2'] : ['-g', '-O0']),
      ...target.flags ?? [],
      ...defineFlags(target.defines ?? {}),
      ...(target.includes ?? []).map(include => `-I${include}`),
      ...cflags,
    ]
    const node: Node = {
      target,
      packages,
      flags,
      links: libs,
      units: [],
      imports: [],
      deps: [...deps],
      output: target.prebuilt ?? path.join(modeDir, target.outfile!),
    }
    const prebuilt = Boolean(target.prebuilt)
    node.units = (await expand(root, target.files ?? [])).map(file => unit(file, flags, node, prebuilt))
    if (node.units.length) node.std = unit(std, [...languageFlags(flags), ...stdWarnings], node, prebuilt)
    const language = languageFlags(flags).join('\0')
    node.imports = node.deps.flatMap(dep => languageFlags(dep.flags).join('\0') == language
      ? dep.units
      : dep.units.map(source => unit(source.file, [...languageFlags(flags), ...sourceFlags(dep.flags)], node, true)))
    nodes.set(target, node)
    return node
  }

  for (const target of roots) await visit(target)
  return { nodes: [...nodes.values()], units: [...units.values()] }
}
