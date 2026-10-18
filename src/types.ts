export type Dependency = Target | string

export type Target = {
  outfile?: string                          // relative to the mode folder: .so (Linux) / .dylib (macOS) shared, .a static, else executable. Omit for header-only
  files?: string[]                          // globs relative to the root build.ts
  // Fully static executable. buildcpp handles the per-OS details (macOS can't link libc statically),
  // otherwise we could've just exposed link flags
  static?: boolean
  flags?: string[]                          // extra compile flags. Default -std=c++26, override with e.g. '-std=c++23'
  defines?: Record<string, string | true>   // strings become C string literals
  includes?: string[]                       // also passed to every target that depends on this one
  deps?: Dependency[]
}

export type Config = {
  targets: Record<string, Target>           // keys are CLI names
}
