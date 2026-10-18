import path from 'node:path'
import { platform } from './platform'
import { unitPath, type Node, type Unit } from './resolve'
import type { Target } from './types'

export type Step = {
  label: 'MODULE' | 'CXX' | 'LINK' | 'AR'
  name: string         // shown in progress: the source, or the linked output
  group: string
  command: string[]
  outputs: string[]
  inputs: Step[]       // steps whose outputs this one reads
  signature: bigint    // hash of command + input contents; rerun when it differs from the cached one
}

const update = async (file: string, text: string) => {
  const handle = Bun.file(file)
  if (!(await handle.exists()) || await handle.text() != text) await Bun.write(file, text)
}

const isArchive = (outfile: string) => outfile.endsWith('.a')
const isShared = (outfile: string) => outfile.endsWith(platform.extension)

const sign = (command: string[], digests: bigint[]) =>
  BigInt(Bun.hash(BigUint64Array.from([BigInt(Bun.hash(command.join('\0'))), ...digests])))

export const plan = async (root: string, cache: string, nodes: Node[], units: Unit[], names: Map<Target, string>) => {
  const group = (node: Node) => names.get(node.target) ?? node.target.outfile ?? node.output!
  const bmi = (unit: Unit) => path.join(cache, unit.hash, 'modules', `${unit.provides!.replace(':', '-')}.pcm`)
  const object = (unit: Unit) => unitPath(cache, unit, 'objects', '.o')

  const modules = new Map<Node, Map<string, Unit>>()
  for (const node of nodes) {
    const visible = new Map<string, Unit>()
    for (const unit of [...node.imports, ...node.units]) if (unit.provides) visible.set(unit.provides, unit)
    if (node.std) visible.set('std', node.std)
    modules.set(node, visible)
  }

  const imports = (unit: Unit) => {
    const visible = modules.get(unit.node)!
    const found = new Map<string, Unit>()
    const visit = (names: string[]) => {
      for (const name of names) {
        if (found.has(name)) continue
        const provider = visible.get(name)
        if (!provider) throw new Error(`${unit.file}: unknown module '${name}'`)
        found.set(name, provider)
        visit(provider.requires)
      }
    }
    visit(unit.requires)
    return [...found]
  }

  const steps: Step[] = []
  const commands = []
  const compiles = new Map<Unit, Step>()
  const active = new Set<Unit>()
  const compile = (unit: Unit): Step => {
    const existing = compiles.get(unit)
    if (existing) return existing
    if (active.has(unit)) throw new Error(`${unit.file}: module import cycle`)
    active.add(unit)
    const needed = imports(unit)
    const inputs = needed.map(([, provider]) => compile(provider))
    const flags = [...unit.flags, ...needed.map(([name, provider]) => `-fmodule-file=${name}=${bmi(provider)}`)]
    const output = ['-o', object(unit)]
    const command = unit.provides
      ? ['clang++', ...flags, '-x', 'c++-module', '-c', unit.file, '-fmodules-reduced-bmi', `-fmodule-output=${bmi(unit)}`, ...output]
      : ['clang++', ...flags, '-c', unit.file, ...output]
    const step: Step = {
      label: unit.provides ? 'MODULE' : 'CXX',
      name: unit.provides == 'std' ? 'std' : unit.file,
      group: group(unit.node),
      command,
      outputs: [object(unit), ...unit.provides ? [bmi(unit)] : []],
      inputs,
      signature: sign(command, [unit.digest, ...inputs.map(input => input.signature)]),
    }
    commands.push({
      directory: root,
      file: unit.file,
      arguments: ['clang++', ...flags, ...unit.provides ? ['-x', 'c++-module'] : [], '-c', unit.file, ...output],
    })
    active.delete(unit)
    compiles.set(unit, step)
    steps.push(step)
    return step
  }
  for (const unit of units) if (!unit.bmiOnly || unit.provides) compile(unit)

  const links = new Map<Node, Step>()
  const linked = new Map<Node, Set<Unit>>()
  for (const node of nodes) {
    const inherited = new Set(node.deps.flatMap(dep => [...linked.get(dep)!]))
    const own = [...node.units, ...node.std ? [node.std] : []].filter(unit => !inherited.has(unit))
    linked.set(node, new Set(own))
    if (!node.output) continue
    const outfile = node.target.outfile!
    const objects = own.filter(unit => !unit.bmiOnly).map(compile)
    const files = objects.map(step => step.outputs[0])
    const dependencies = node.deps.filter(dep => dep.output).toReversed()   // header-only deps have nothing to link
    const executable = dependencies.find(dep => !isArchive(dep.target.outfile!) && !isShared(dep.target.outfile!))
    if (executable) throw new Error(`${outfile}: can't depend on executable ${executable.target.outfile}`)
    const archive = isArchive(outfile)
    const shared = isShared(outfile)
    if (node.target.static && (archive || shared)) throw new Error(`${outfile}: static applies to executables only`)
    const command = archive
      ? ['llvm-ar', 'rcs', node.output, ...files]
      : [
          'clang++',
          ...node.target.static ? platform.static : [],
          ...shared ? platform.shared(path.basename(outfile)) : [],
          '-o', node.output, ...files,
          ...dependencies.map(dep => dep.output!), ...node.linkFlags,
          ...platform.link(), platform.rpath,
        ]
    const inputs = [...objects, ...archive ? [] : dependencies.map(dep => links.get(dep)!)]
    const step: Step = {
      label: archive ? 'AR' : 'LINK',
      name: node.output,
      group: group(node),
      command,
      outputs: [node.output],
      inputs,
      signature: sign(command, inputs.map(input => input.signature)),
    }
    links.set(node, step)
    steps.push(step)
  }

  await update(path.join(root, 'compile_commands.json'), JSON.stringify(commands, undefined, 2) + '\n')
  return { steps, links }
}
