import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export type FileEntry = { mtime: number; hash: bigint }
export type UnitEntry = { provides?: string; requires: string[]; inputs: string[] }
export type Cache = {
  files: Map<string, FileEntry>    // path → content hash, reused while mtime matches
  units: Map<string, UnitEntry>    // unit key → clang-scan-deps result
  steps: Map<string, bigint>       // output → signature of the step that built it
}

// Layout, little endian: magic, string table (strings joined by \0), then files, units, steps.
// Every string is a u32 index into the table, so each path is stored once.
const magic = 0x31504342 // "BCP1"
const none = 0xffffffff

export const emptyCache = (): Cache => ({ files: new Map(), units: new Map(), steps: new Map() })

export const readCache = async (file: string): Promise<Cache> => {
  const handle = Bun.file(file)
  if (!(await handle.exists())) return emptyCache()
  const view = new DataView(await handle.arrayBuffer())
  let offset = 0
  const read = <T>(size: number, get: (at: number) => T) => {
    const value = get(offset)
    offset += size
    return value
  }
  const u32 = () => read(4, at => view.getUint32(at, true))
  const f64 = () => read(8, at => view.getFloat64(at, true))
  const u64 = () => read(8, at => view.getBigUint64(at, true))

  if (view.byteLength < 8 || u32() != magic) return emptyCache()
  const length = u32()
  const strings = new TextDecoder().decode(new Uint8Array(view.buffer, offset, length)).split('\0')
  offset += length
  const optional = () => {
    const id = u32()
    return id == none ? undefined : strings[id]
  }
  const list = () => Array.from({ length: u32() }, () => strings[u32()])

  const cache = emptyCache()
  for (let count = u32(); count; count--) cache.files.set(strings[u32()], { mtime: f64(), hash: u64() })
  for (let count = u32(); count; count--) cache.units.set(strings[u32()], { provides: optional(), requires: list(), inputs: list() })
  for (let count = u32(); count; count--) cache.steps.set(strings[u32()], u64())
  return cache
}

const writer = () => {
  let view = new DataView(new ArrayBuffer(1 << 16))
  let offset = 0
  const write = (size: number, set: (at: number) => void) => {
    if (offset + size > view.byteLength) {
      const grown = new Uint8Array(Math.max(view.byteLength * 2, offset + size))
      grown.set(new Uint8Array(view.buffer, 0, offset))
      view = new DataView(grown.buffer)
    }
    set(offset)
    offset += size
  }
  return {
    u32: (value: number) => write(4, at => view.setUint32(at, value, true)),
    f64: (value: number) => write(8, at => view.setFloat64(at, value, true)),
    u64: (value: bigint) => write(8, at => view.setBigUint64(at, value, true)),
    bytes: () => new Uint8Array(view.buffer, 0, offset),
  }
}

export const writeCache = async (file: string, cache: Cache) => {
  const ids = new Map<string, number>()
  const id = (text: string) => {
    const known = ids.get(text)
    if (known != undefined) return known
    ids.set(text, ids.size)
    return ids.size - 1
  }
  const body = writer()
  const list = (items: string[]) => {
    body.u32(items.length)
    for (const item of items) body.u32(id(item))
  }

  body.u32(cache.files.size)
  for (const [file, { mtime, hash }] of cache.files) {
    body.u32(id(file))
    body.f64(mtime)
    body.u64(hash)
  }
  body.u32(cache.units.size)
  for (const [key, { provides, requires, inputs }] of cache.units) {
    body.u32(id(key))
    body.u32(provides == undefined ? none : id(provides))
    list(requires)
    list(inputs)
  }
  body.u32(cache.steps.size)
  for (const [output, signature] of cache.steps) {
    body.u32(id(output))
    body.u64(signature)
  }

  const strings = new TextEncoder().encode([...ids.keys()].join('\0'))
  const head = writer()
  head.u32(magic)
  head.u32(strings.length)
  await Bun.write(file, new Blob([head.bytes(), strings, body.bytes()]))
}

// Content hash of a file, rehashed only when its mtime changed since the previous run
export const hasher = (root: string, previous: Cache, next: Cache) => (file: string) => {
  const known = next.files.get(file)
  if (known) return known.hash
  const absolute = path.resolve(root, file)
  const stat = statSync(absolute, { throwIfNoEntry: false })
  const old = previous.files.get(file)
  const hash = !stat ? 0n : old?.mtime == stat.mtimeMs ? old.hash : BigInt(Bun.hash(readFileSync(absolute)))
  next.files.set(file, { mtime: stat?.mtimeMs ?? 0, hash })
  return hash
}
