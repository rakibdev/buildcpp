import path from 'node:path'

type Manifest = { modules: { 'logical-name': string; 'source-path': string }[] }

export const stdSource = async () => {
  const manifest = '/usr/lib/libstdc++.modules.json'
  const { modules }: Manifest = await Bun.file(manifest).json()
  const std = modules.find(module => module['logical-name'] == 'std')!
  return path.resolve(path.dirname(manifest), std['source-path'])
}
