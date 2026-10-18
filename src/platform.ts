import path from 'node:path'
import { realpathSync } from 'node:fs'

const darwin = process.platform == 'darwin'

// Real install dir of the clang++ on PATH (Homebrew links bin/ into its Cellar)
export const clangDir = () => {
  const found = Bun.which('clang++')
  if (!found) throw new Error('clang++ not found on PATH')
  return path.dirname(realpathSync(found))
}

// Homebrew llvm's libc++ is newer than the system one its headers would otherwise link against.
// Linked statically so binaries run on Macs without Homebrew
const libcxx = () => path.join(clangDir(), '../lib/c++')

export const platform = darwin
  ? {
      extension: '.dylib',
      compile: ['-stdlib=libc++'],
      link: () => ['-nostdlib++', path.join(libcxx(), 'libc++.a'), path.join(libcxx(), 'libc++abi.a')],
      static: [],                                                   // no static libSystem on macOS. libc++ is already static via link()
      shared: (name: string) => ['-dynamiclib', `-Wl,-install_name,@rpath/${name}`],
      rpath: '-Wl,-rpath,@loader_path',
    }
  : {
      extension: '.so',
      compile: [],
      link: () => [],
      static: ['-static'],
      shared: (name: string) => ['-shared', `-Wl,-soname,${name}`],
      rpath: '-Wl,-rpath,$ORIGIN',
    }
