export type Dependency = Target | string

export type Target = {
  outfile?: string                          // relative to the mode folder: .so shared, .a static, else executable
  prebuilt?: string                         // existing library: `files` compile as interfaces only
  files?: string[]                          // globs relative to the root build.ts
  std?: 'c++20' | 'c++23' | 'c++26'
  flags?: string[]
  defines?: Record<string, string | true>   // strings become C string literals
  includes?: string[]
  deps?: Dependency[]
}

export type Config = {
  outDir?: string                           // default 'build'
  targets: Record<string, Target>           // keys are CLI names
}
