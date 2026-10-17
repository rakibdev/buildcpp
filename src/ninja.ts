import path from 'node:path'
import { ninjaPath, ninjaValue } from './quote'
import { unitPath, type Node, type Unit } from './resolve'

const rules = `rule module
  command = clang++ $flags $modules -x c++-module -c $source -fmodules-reduced-bmi -fmodule-output=$bmi -o $out
  description = MODULE $source

rule object
  command = clang++ $flags $modules -c $source -o $out
  description = CXX $source

rule shared
  command = clang++ -shared -o $out $in $links -Wl,-soname,$soname -Wl,-rpath,'$$ORIGIN'
  description = LINK $out

rule static
  command = rm -f $out && llvm-ar rcs $out $in
  description = AR $out

rule program
  command = clang++ -o $out $in $links -Wl,-rpath,'$$ORIGIN'
  description = LINK $out
`

const update = async (file: string, text: string) => {
  const handle = Bun.file(file)
  if (!(await handle.exists()) || await handle.text() != text) await Bun.write(file, text)
}

const linkRule = (outfile: string) => outfile.endsWith('.so') ? 'shared' : outfile.endsWith('.a') ? 'static' : 'program'

export const writeNinja = async (root: string, cache: string, nodes: Node[], units: Unit[]) => {
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
    return [...found.entries()].map(([name, provider]) => ({ name, file: bmi(provider) }))
  }

  const lines = [`builddir = ${ninjaPath(cache)}`, '']
  for (const hash of new Set(units.map(unit => unit.hash)))
    lines.push(`flags_${hash} = ${ninjaValue(units.find(unit => unit.hash == hash)!.flags)}`)
  lines.push('', rules)

  const commands = []
  for (const unit of units) {
    if (unit.bmiOnly && !unit.provides) continue
    const needed = imports(unit)
    const moduleFlags = needed.map(({ name, file }) => `-fmodule-file=${name}=${file}`)
    const outputs = [ninjaPath(object(unit)), ...unit.provides ? ['|', ninjaPath(bmi(unit))] : []]
    const inputs = [ninjaPath(unitPath(cache, unit, 'stamps')), ...needed.map(({ file }) => ninjaPath(file))]
    lines.push(`build ${outputs.join(' ')}: ${unit.provides ? 'module' : 'object'} ${inputs.join(' ')}`)
    lines.push(`  flags = $flags_${unit.hash}`, `  source = ${ninjaValue([unit.file])}`)
    if (needed.length) lines.push(`  modules = ${ninjaValue(moduleFlags)}`)
    if (unit.provides) lines.push(`  bmi = ${ninjaValue([bmi(unit)])}`)
    commands.push({
      directory: root,
      file: unit.file,
      arguments: ['clang++', ...unit.flags, ...moduleFlags, ...unit.provides ? ['-x', 'c++-module'] : [], '-c', unit.file, '-o', object(unit)],
    })
  }

  const linked = new Map<Node, Set<Unit>>()
  for (const node of nodes) {
    const inherited = new Set(node.deps.flatMap(dep => [...linked.get(dep)!]))
    const own = [...node.units, ...node.std ? [node.std] : []].filter(unit => !inherited.has(unit))
    linked.set(node, new Set(own))
    if (node.target.prebuilt) continue
    const outfile = node.target.outfile!
    const libraries = node.deps.toReversed().map(dep => dep.output)
    const rule = linkRule(outfile)
    const implicit = rule == 'static' || !libraries.length ? [] : ['|', ...libraries.map(ninjaPath)]
    const objects = own.filter(unit => !unit.bmiOnly).map(unit => ninjaPath(object(unit)))
    lines.push('', `build ${ninjaPath(node.output)}: ${rule} ${[...objects, ...implicit].join(' ')}`)
    if (rule != 'static') lines.push(`  links = ${ninjaValue([...libraries, ...node.links])}`)
    if (rule == 'shared') lines.push(`  soname = ${ninjaValue([path.basename(outfile)])}`)
  }

  const manifest = path.join(cache, 'build.ninja')
  await update(manifest, lines.join('\n') + '\n')
  await update(path.join(root, 'compile_commands.json'), JSON.stringify(commands, undefined, 2) + '\n')
  return manifest
}
