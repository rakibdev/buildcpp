import type { Subprocess } from 'bun'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Cache } from './cache'
import { progress, tty } from './progress'
import type { Step } from './steps'

// Binary heap, highest score on top
const queue = <T>(score: (item: T) => number) => {
  const items: T[] = []
  const higher = (a: number, b: number) => score(items[a]) > score(items[b])
  const swap = (a: number, b: number) => [items[a], items[b]] = [items[b], items[a]]
  return {
    size: () => items.length,
    push: (item: T) => {
      items.push(item)
      for (let index = items.length - 1; index && higher(index, (index - 1) >> 1); index = (index - 1) >> 1) swap(index, (index - 1) >> 1)
    },
    pop: () => {
      const top = items[0]
      const last = items.pop()!
      if (items.length) {
        items[0] = last
        for (let index = 0; ;) {
          let best = index
          for (const child of [index * 2 + 1, index * 2 + 2]) if (child < items.length && higher(child, best)) best = child
          if (best == index) break
          swap(index, best)
          index = best
        }
      }
      return top
    },
  }
}

// Runs the dirty steps `wanted` needs, in parallel. `all` is the graph of every target:
// outputs the previous run built that are not in it get deleted. `save` runs every 5s so a killed
// build keeps most of its work. Returns the exit code.
export const run = async (root: string, all: Step[], wanted: Step[], previous: Cache, next: Cache, save: () => Promise<void>) => {
  const absolute = (output: string) => path.resolve(root, output)
  const outputs = new Set(all.flatMap(step => step.outputs))
  for (const [output, signature] of previous.steps)
    if (outputs.has(output)) next.steps.set(output, signature)
    else rmSync(absolute(output), { force: true })

  const pending = new Set<Step>()
  const seen = new Set<Step>()
  const visit = (step: Step) => {
    if (seen.has(step)) return
    seen.add(step)
    step.inputs.forEach(visit)
    if (step.outputs.some(output => next.steps.get(output) != step.signature || !existsSync(absolute(output)))) pending.add(step)
  }
  wanted.forEach(visit)

  const blockers = new Map<Step, number>()
  const dependents = new Map<Step, Step[]>()
  for (const step of pending) {
    const inputs = step.inputs.filter(input => pending.has(input))
    blockers.set(step, inputs.length)
    for (const input of inputs) {
      const list = dependents.get(input)
      if (list) list.push(step)
      else dependents.set(input, [step])
    }
  }
  // Longest chain of pending steps hanging off each step: start the longest first, like ninja's critical path
  const depths = new Map<Step, number>()
  const depth = (step: Step): number => {
    const known = depths.get(step)
    if (known != undefined) return known
    const value = 1 + Math.max(0, ...(dependents.get(step) ?? []).map(depth))
    depths.set(step, value)
    return value
  }
  const ready = queue(depth)
  for (const step of pending) if (!blockers.get(step)) ready.push(step)

  const display = progress(pending.size)
  const children = new Set<Subprocess>()
  let code = 0
  const interrupt = () => {
    code = 130
    for (const child of children) child.kill()
  }
  process.on('SIGINT', interrupt)

  const execute = async (step: Step) => {
    for (const output of step.outputs) {
      next.steps.delete(output)
      mkdirSync(path.dirname(absolute(output)), { recursive: true })
      rmSync(absolute(output), { force: true })
    }
    const command = tty && step.command[0] == 'clang++' ? [...step.command, '-fcolor-diagnostics'] : step.command
    const child = Bun.spawn(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    children.add(child)
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    children.delete(child)
    if (status) {
      if (!code) {
        code = 1
        display.fail(step, stdout + stderr)
      }
      return
    }
    for (const output of step.outputs) next.steps.set(output, step.signature)
    display.finish(step, stdout + stderr)
    for (const dependent of dependents.get(step) ?? []) {
      const count = blockers.get(dependent)! - 1
      blockers.set(dependent, count)
      if (!count) ready.push(dependent)
    }
  }

  const jobs = navigator.hardwareConcurrency + 2 // ninja's default: keeps cores busy while processes start and exit
  const active = new Set<Promise<void>>()
  const launch = () => {
    while (!code && active.size < jobs && ready.size()) {
      const job: Promise<void> = execute(ready.pop()).finally(() => active.delete(job))
      active.add(job)
    }
  }
  let saving = Promise.resolve()
  const timer = setInterval(() => saving = saving.then(save), 5000)
  launch()
  while (active.size) {
    await Promise.race(active)
    launch()
  }
  clearInterval(timer)
  await saving

  process.off('SIGINT', interrupt)
  display.end(code)
  return code
}
