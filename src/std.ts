import { $ } from 'bun'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { clangDir } from './platform'

type Manifest = { modules: { 'logical-name': string; 'source-path': string }[] }

// Same lookup as xmake (rules/c++/modules/{gcc,clang}/support.lua)
const manifestPath = async () => {
  // GCC's own search, so it follows whatever libstdc++ version is installed
  if (process.platform != 'darwin') return (await $`clang++ -print-file-name=libstdc++.modules.json`.text()).trim()
  // --sysroot at clang's install, otherwise it answers <NOT PRESENT>
  const llvm = path.join(clangDir(), '..')
  const found = (await $`clang++ -std=c++23 -stdlib=libc++ --sysroot=${llvm} -print-library-module-manifest-path`.text()).trim()
  return found.startsWith('<NOT PRESENT>') ? path.join(llvm, 'lib/libc++.modules.json') : found
}

export const stdSource = async () => {
  const manifest = await manifestPath()
  // -print-file-name echoes the bare name back when nothing matches
  if (!existsSync(manifest)) throw new Error(`std module manifest not found: ${manifest}`)
  const { modules }: Manifest = await Bun.file(manifest).json()
  const std = modules.find(module => module['logical-name'] == 'std')!
  return path.resolve(path.dirname(manifest), std['source-path'])
}
