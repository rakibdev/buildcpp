# Why buildcpp

buildcpp (`~/Downloads/buildcpp`) is a small Bun/TS tool: it reads `build.ts`, plans every compile and link step, and runs them itself (ninja was dropped, see No ninja). This file records why it replaced xmake, why mcpp was rejected, and the design decisions that were tested and must not be reverted. Plan and implementation details: `buildcpp.md`.

## Numbers (Oct 17 2026, 4 cores, clang 23.1.3)

Release build of core + launcher, same sources for both tools. xmake's release caches and its own compile cache (`build/.build_cache`) were deleted before its clean build.

| case | xmake | buildcpp |
|---|---|---|
| clean build | 83.4s | **64.0s** |
| `touch src/config.cppm` (11 importers) | 40.3s | **0.06s**, nothing compiled |
| edit `addClass` body in `src/elements/base.cppm` (16 importers) | 14.9s | 15.5s |
| same edit, after moving bodies to `base.cpp` | — | **1.96s**, 1 file + relink |
| no-op | — | 0.05s |
| `libsystem-ui.so` (stripped) | 436,808 B | 428,536 B |
| `launcher.so` (stripped) | 312,432 B | 304,128 B |
| release cache | 645M | 361M |

xmake builds `-O3`, buildcpp `-O2` (Arch's makepkg default), so part of the size difference is the flag.

BMI sizes (the compiled module interfaces importers load):

| module | xmake (full BMI) | buildcpp, before glaze wrapper | buildcpp, after |
|---|---|---|---|
| daemon | 62MB | 38MB | 5.0MB |
| audio | 49MB | 33MB | 5.2MB |
| config | 46MB | 37MB | 29KB |
| storage | 45MB | 35MB | 23KB |

## xmake pain points

- **Rebuilds by timestamp.** `touch`, `git checkout`, or edit-then-revert of a module interface recompiles every importer (40s for `config.cppm`). `learning.md` needed a workaround (splitting `X.impl.cppm` partitions), and it only helped impl-only edits.
- **One target per invocation.** `xmake build ui && xmake build launcher`; buildcpp builds any number in one graph: `buildcpp ui launcher`.
- **Package flags leak everywhere and silently break module reuse.** xmake adds every package's flags to every file (`-mfpmath=sse -msse2 -pthread -DPCRE2_CODE_UNIT_WIDTH=8 ...`). If an extension's package list differs from core's by one entry, `build.c++.modules.reuse` silently falls back to recompiling every BMI. `set_extension` carried a comment warning about exactly this. buildcpp compiles a file once per distinct flag set, automatically.
- **Mode is global state.** Each PKGBUILD did `xmake config --mode=release` → build → `xmake config --mode=debug`, and release output overwrote the dev `build/`. Found during the comparison: `build/*.so` were stripped release binaries while xmake's config said `debug`. buildcpp: `build/dev/` and `build/release/`, chosen per run with `--release`.
- **Config sprawl.** 7 Lua files, a global `setup()`, helpers (`set_extension`, `sdk`, `build_in_root`), `set_prefixname("")` to drop `lib`. buildcpp: one `build.ts` with plain objects and spreads; the `outfile` extension decides the kind (`.so`, `.a`, else executable).
- **Full BMIs, two compile steps.** xmake runs `--precompile` and then a separate object compile, producing BMIs 25–65% bigger. buildcpp produces a reduced BMI and the object in one clang call (`-fmodules-reduced-bmi -fmodule-output=`).

## mcpp (rejected, tested v2026.10.17.1)

- Hermetic by design: downloads its own glibc and blocks `/usr/include` (`-nostdlibinc`), then links with an rpath to that private glibc, inside a process that loads system GTK.
- Its clang toolchain finds only libc++'s `std.cppm`, not libstdc++'s `std.cc`, so `import std` fails with system clang.
- `[toolchain].bootstrap` must be a managed download; it can't point at `/usr`.
- No pkg-config; flags pasted by hand.
- A workspace root package plus a member produced a duplicate ninja rule (`multiple rules generate bin/libsystem-ui.so`).
- Its "don't rebuild importers when the BMI didn't change" check (`bmi_equivalent` in `src/build/stage.cppm`) only masks GCC's `buildtime:`/`localtime:` stamps; the source comment admits it "has NEVER ONCE FIRED" before that masking. For clang it compares bytes, so it hits the clang bug below too.

## No ninja (dropped Oct 18 2026)

buildcpp used to write `build.ninja` and run ninja. It now runs the steps itself (`src/run.ts`), because ninja's output can't show what is compiling and, at buildcpp's scale, ninja made the build slower rather than faster. The numbers in the first table were measured with the ninja version.

### Why

- **Progress.** When ninja's output is piped, it prints a step's status only after the step finishes, so a wrapper can't know what's running. mcpp works around this in 1659 lines (`src/build/progress.cppm`): a marker in `NINJA_STATUS`, re-reading `.ninja_log` for start times, a start file written by a wrapper, and a step-to-package table. Running the processes ourselves gives all of that for free.
- **Speed.** ninja is fast at reading huge build files (Chrome-scale, 50k+ steps). buildcpp keeps its graph in memory, so that was pure overhead: on the fake project below, writing `build.ninja` (7.3MB) took 165ms, `ninja -t cleandead` 49ms and the ninja run itself 68ms, about 70% of a 0.40s no-op.
- **xmake has no ninja either**: `modules/async/runjobs.lua` + `jobgraph.lua` run jobs on its own Lua scheduler, `modules/utils/progress.lua` draws the progress. xmake's slowness was rebuilding by timestamp, not its runner.
- One fewer system dependency.

### Numbers (fake project, 4 cores, clang 23.1.3)

10 libraries × (250 modules + 250 `.cpp` units) + one program = 5001 sources and 460 headers. Each file includes 3 of 40 umbrella headers (about 30 headers each) and imports one module. Generator: `/tmp/gen-fake.ts`, output in `/tmp/fake` (tmpfs, gone after a reboot).

| case | ninja | buildcpp runner |
|---|---|---|
| clean build (5013 steps) | ~62s | **59.4s** |
| edit `include/leaf5.hpp` (3135 steps) | 37.5s | **35.9s** |
| no-op | 0.40s | **0.30s** |
| `touch include/leaf5.hpp` | 0.40s, nothing compiled | **0.31s**, nothing compiled |
| scan cache | 5.8MB `scan.json` | 1.6MB `cache.bin` (also holds step signatures) |

The ninja clean build was split across two runs (58s + 4s), so it's approximate. The runner numbers are single runs in a terminal.

### How it works

- `src/steps.ts` turns the graph into steps (command, outputs, input steps, signature) and writes `compile_commands.json`.
- `src/run.ts` runs the dirty steps the requested targets need, deletes stale outputs, and stops starting new steps after the first failure.
- `src/cache.ts` stores everything in one binary file: a string table (each path stored once, joined by `\0`), then files (path, mtime, content hash), scan results (module name, imports, input file ids) and step signatures per output.
- `src/progress.ts`: on a terminal, one line `[3153/5013] 6 running · 44.9s` redrawn 10×/s, with finished links, warnings and failures printed above it. Piped: one plain line per finished step.

### Decisions from testing

- **`nproc + 2` jobs** (ninja's default). With `nproc` only 2.5 of 4 cores were busy: 3905 steps in 57s against ninja's ~4800.
- **Longest chain of waiting steps first** (a binary heap ranked by how many dirty steps hang off each step, like ninja 1.12's critical path). Header edit went from 41.8s with first-come order to 38.5s. A step that only links depend on (`std` in the fake project, where no file imports it) starts late; in system-ui every file imports `std`, so it goes first. Ranking by last run's durations wasn't needed after the next fix.
- **One status line, no live list of running files.** Redrawing the status line plus a line per running file on every start and finish took the clean build from 59.4s to 73.3s, all in terminal output.
- **Cache saved every 5s and at the end**, not after every step: rewriting the 1.6MB file 5k times would be about 8GB of writes. Ctrl+C kills the running compiles and saves; SIGKILL, out-of-memory or closing the terminal lose at most the last 5s of work. They're not handled.
- **Outputs are deleted before their step runs** and the step's stored signature is dropped until it succeeds, so a failed or killed step always reruns and `llvm-ar rcs` never appends to an old archive.
- **`-fcolor-diagnostics` is added only when stdout is a terminal**, at spawn time, and is not part of the signature, so running piped in CI doesn't rebuild everything.

## Decisions not to revert

### Rebuild by source content, not BMI content

Each step has a signature: a hash of its command, the content hash of its source **and every header it includes**, and the signatures of the steps whose BMIs it imports (a link: its objects' and libraries' signatures). It reruns only when the signature differs from the one stored for its output in `build/<mode>/.cache/cache.bin`, or the output is missing. File mtimes are only a shortcut to skip rehashing an unchanged file; they never decide a rebuild.

Don't add back **BMI content compare** (compile to `x.pcm.new`, keep the old file if bytes match). It was implemented and removed because:

1. **Clang writes garbage bytes into some BMIs.** For a consteval call it never evaluated, clang stores a `ConstantExpr` with `ResultKind=Int64`, `APValueKind=0`, and `ASTStmtWriter::VisitConstantExpr` writes its `Int64Result`, which the `ConstantExpr` constructor (`clang/lib/AST/Expr.cpp`) never initializes. Leftover heap addresses land in the BMI, so two compiles of the identical file differ. Still in LLVM main; no LLVM issue found. It hit exactly the modules using glaze (consteval-heavy): `config`, `storage`, `daemon`, `daemon.impl`, `audio`, launcher's `pinned`. Result: `touch config.cppm` still rebuilt all 11 importers (37s).
2. **After content signatures it adds almost nothing.** It only helps when the source changed but the BMI didn't, which in practice means same-length comment edits. Longer edits shift source locations, and clang stores a hash of every function body in the BMI (`DECL_FUNCTION`'s ODR hash, no flag disables it), so body edits change the BMI anyway.
3. **Cost.** One extra process per module compile, plus reading two BMIs of up to 40MB.

Patching clang instead was rejected: about 1–2h to rebuild clang on 4 cores / 7GB, again on every clang update.

### No clang depfile (`-MD`)

A depfile only feeds timestamp checks (it's what made ninja compare the source's mtime, so `touch` rebuilt again). Headers are tracked by buildcpp instead: one `clang-scan-deps -format=experimental-full` pass gives each file's module name, its imports, and every header it includes (814 for `config.cppm`). Those headers' content hashes feed the signature.

### Function bodies go in `.cpp` implementation units

Because of that per-body hash, an edit to a function body inside `X.cppm` changes the BMI and rebuilds every importer, whichever build tool you use. Keep declarations, templates and `inline`/`constexpr` code in `X.cppm` and put bodies in `X.cpp` (`module X;`, no BMI, no `import X;`). That's what took the `addClass` edit from 15.5s to 1.96s. The old `X.impl.cppm` partitions (`module X:impl;` + `import X;`) are gone: they produced a BMI nobody imported.

### glaze stays wrapped in `src/glaze.cppm`

Don't go back to `#include <glaze/glaze.hpp>` at the top of a module. Every such module parsed ~110k lines of glaze and copied them into its own BMI (33–40MB), loaded by every importer; `config.cppm` took 8.8s to compile, now 0.1s. The wrapper also confines the garbage-bytes bug to `glaze.pcm`, which only rebuilds when glaze itself changes. If you need another glaze name, add it to the `using` list in `src/glaze.cppm`. Note that glaze's headers had been leaking `<ctype.h>` into `audio.cppm` (`::tolower`); use `std::` functions from `import std` instead.

### One std BMI shared by targets that differ only in defines

`std` is compiled with the target's flags minus `-D`/`-I`/`-U`. core (`SHARE_DIR`) and launcher (`EXT_DIR`) then share one `std.pcm`. With per-target std BMIs, a launcher file importing `log` (built against core's std) plus its own std would load two different `std` modules and fail.

### One graph with all targets, always

`buildcpp launcher` still plans every target and only runs the steps launcher needs. Outputs the previous run built that are not in the graph (a deleted source's `.o`/`.pcm`, a removed target) are deleted every run, like `ninja -t cleandead` did; with a graph of only the requested targets it would delete panel's objects whenever you build launcher.

### Deps with different language flags get their interfaces recompiled

Clang refuses a module compiled with different language flags (e.g. a library without gtk built without `-pthread`, imported by a gtk file). When a dep's flags minus `-D`/`-I`/`-U` differ from the importer's, its interfaces are compiled again with the importer's flags, BMI only. Don't "simplify" this to always reuse the dep's BMI.

### Smaller things that were tested

- **No `cmp` / `diff` in commands**: `diffutils` isn't in Arch `base` or `base-devel` (it's not installed here).
- **clang-scan-deps needs an `output` field** in each compilation-database entry; with only `arguments` it reports an empty output and results can't be matched back. buildcpp matches by the `-o <index>.o` in each result's `command-line`.
- **Object names keep the extension** (`log.cppm.o`) because `log.cppm` and `log.cpp` sit side by side.
- **`compile_commands.json` is written by buildcpp** (`steps.ts`), only when its text changed, so clangd doesn't reload.
- **`/tmp` is mounted noexec**: run scripts there with `bash script.sh`.
- **Not GCC**: its BMIs embed `buildtime:`/`localtime:` stamps (needs masking), and clang was the chosen compiler.
- **No header units, no package index**: not used by system-ui; scanning before anything compiles catches new `import` lines without a second pass; package-index entries are install scripts, not URLs.
