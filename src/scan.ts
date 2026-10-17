import { $ } from 'bun'
import path from 'node:path'
import type { Cache, UnitEntry } from './cache'
import type { Unit } from './resolve'

type Command = {
  'command-line': string[]
  'named-module'?: string
  'named-module-deps'?: string[]
  'file-deps': string[]
}

export const scan = async (root: string, cache: string, units: Unit[], previous: Cache, next: Cache, hash: (file: string) => bigint) => {
  const apply = (unit: Unit, entry: UnitEntry) => {
    next.units.set(unit.key, entry)
    unit.provides = entry.provides
    unit.requires = entry.requires
    unit.digest = BigInt(Bun.hash(BigUint64Array.from(entry.inputs, hash)))
  }

  const stale: Unit[] = []
  for (const unit of units) {
    const entry = previous.units.get(unit.key)
    if (entry && !entry.inputs.some(input => hash(input) != previous.files.get(input)?.hash)) apply(unit, entry)
    else stale.push(unit)
  }
  if (!stale.length) return

  const database = path.join(cache, 'scan-database.json')
  await Bun.write(database, JSON.stringify(stale.map((unit, index) => ({
    directory: root,
    file: unit.file,
    output: `${index}.o`,
    arguments: ['clang++', ...unit.flags, ...unit.file.endsWith('.cppm') ? ['-x', 'c++-module'] : [], '-c', unit.file, '-o', `${index}.o`],
  }))))
  const result: { 'translation-units': { commands: Command[] }[] } =
    await $`clang-scan-deps -format=experimental-full -compilation-database=${database}`.cwd(root).json()
  for (const { commands: [command] } of result['translation-units']) {
    const line = command['command-line']
    apply(stale[parseInt(line[line.indexOf('-o') + 1])], {
      provides: command['named-module'],
      requires: command['named-module-deps'] ?? [],
      inputs: command['file-deps'],
    })
  }
}
