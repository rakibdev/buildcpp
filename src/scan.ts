import { $ } from 'bun'
import { readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { unitPath, type Unit } from './resolve'

type FileEntry = { mtime: number; content: string }
type UnitEntry = { provides?: string; requires: string[]; inputs: string[] }
type Cache = { files: Record<string, FileEntry>; units: Record<string, UnitEntry> }

type Command = {
  'command-line': string[]
  'named-module'?: string
  'named-module-deps'?: string[]
  'file-deps': string[]
}

export const scan = async (root: string, cache: string, units: Unit[]) => {
  const cacheFile = Bun.file(path.join(cache, 'scan.json'))
  const previous: Cache = await cacheFile.exists() ? await cacheFile.json() : { files: {}, units: {} }
  const next: Cache = { files: {}, units: {} }

  const changed = (file: string) => {
    if (file in next.files) return next.files[file].content != previous.files[file]?.content
    const stat = statSync(path.resolve(root, file), { throwIfNoEntry: false })
    const old = previous.files[file]
    const content = !stat ? '' : old?.mtime == stat.mtimeMs ? old.content : Bun.hash(readFileSync(path.resolve(root, file))).toString(16)
    next.files[file] = { mtime: stat?.mtimeMs ?? 0, content }
    return content != old?.content
  }

  const stale: { unit: Unit; key: string }[] = []
  for (const unit of units) {
    const key = `${unit.hash}:${unit.file}`
    const entry = previous.units[key]
    const stamp = Bun.file(unitPath(cache, unit, 'stamps'))
    const dirty = !entry || entry.inputs.map(changed).includes(true) || !(await stamp.exists())
    if (dirty) {
      stale.push({ unit, key })
      await Bun.write(stamp, '')
      continue
    }
    next.units[key] = entry
    unit.provides = entry.provides
    unit.requires = entry.requires
  }

  if (stale.length) {
    const database = path.join(cache, 'scan-database.json')
    await Bun.write(database, JSON.stringify(stale.map(({ unit }, index) => ({
      directory: root,
      file: unit.file,
      output: `${index}.o`,
      arguments: ['clang++', ...unit.flags, ...unit.file.endsWith('.cppm') ? ['-x', 'c++-module'] : [], '-c', unit.file, '-o', `${index}.o`],
    }))))
    const result: { 'translation-units': { commands: Command[] }[] } =
      await $`clang-scan-deps -format=experimental-full -compilation-database=${database}`.cwd(root).json()
    for (const { commands: [command] } of result['translation-units']) {
      const line = command['command-line']
      const { unit, key } = stale[parseInt(line[line.indexOf('-o') + 1])]
      const entry = { provides: command['named-module'], requires: command['named-module-deps'] ?? [], inputs: command['file-deps'] }
      entry.inputs.forEach(changed)
      next.units[key] = entry
      unit.provides = entry.provides
      unit.requires = entry.requires
    }
  }

  for (const key of Object.keys(previous.units)) {
    if (key in next.units) continue
    const [hash, ...file] = key.split(':')
    rmSync(unitPath(cache, { hash, file: file.join(':') }, 'stamps'), { force: true })
  }
  await Bun.write(cacheFile, JSON.stringify(next))
}
