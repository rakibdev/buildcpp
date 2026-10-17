import type { Config } from './types'

export type { Config, Dependency, Target } from './types'

export const release = process.argv.includes('--release')
export const defineConfig = (config: Config) => config
