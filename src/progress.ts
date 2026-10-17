import type { Step } from './steps'

export const tty = Boolean(process.stdout.isTTY)
const colored = tty && !process.env.NO_COLOR

const paint = (code: string) => (text: string) => colored ? `\x1b[${code}m${text}\x1b[0m` : text
const bold = paint('1')
const accent = paint('1;94')
const bar = paint('94')
const track = paint('34')
const success = paint('1;96')
const time = paint('96')
const warning = paint('1;93')
const error = paint('1;91')
const muted = paint('38;5;248')
const shown = 10

const seconds = () => time(`${(performance.now() / 1000).toFixed(1)}s`)

let drawn = false

const clear = () => {
  if (drawn) process.stdout.write('\r\x1b[2K')
  drawn = false
}

const print = (text: string) => {
  clear()
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

const status = (text: string) => {
  clear()
  if (!tty) return console.log(text)
  process.stdout.write(text)
  drawn = true
}

export const scanning = (files: number) => status(`${accent('Scanning')} ${bold(String(files))} files…`)

export const progress = (total: number) => {
  const files = new Map<string, string[]>()
  let finished = 0
  let failed = ''

  const block = (group: string) => {
    const list = files.get(group) ?? []
    print([
      success(`✓ ${group}`),
      ...list.slice(0, shown).map(name => `  ${name}`),
      ...list.length > shown ? [`  ${muted(`+${list.length - shown} more`)}`] : [],
    ].join('\n'))
    files.delete(group)
  }

  const draw = () => {
    const width = 30
    const filled = Math.round(width * finished / total)
    status(`${accent('Building')} ${bar('━'.repeat(filled))}${track('─'.repeat(width - filled))} ${bold(`${finished}/${total}`)} · ${seconds()}`)
  }

  const timer = tty && total ? setInterval(draw, 100) : undefined

  return {
    finish: (step: Step, output: string) => {
      finished++
      if (output) print(`${warning('⚠')} ${success(step.group)} · ${bold(step.name)}\n${output}`)
      if (step.label == 'LINK' || step.label == 'AR') return block(step.group)
      const list = files.get(step.group)
      if (list) list.push(step.name)
      else files.set(step.group, [step.name])
    },
    fail: (step: Step, output: string) => {
      failed = step.group
      print(`${error('✗')} ${success(step.group)} · ${bold(step.name)}\n${output}`)
    },
    end: (code: number) => {
      clearInterval(timer)
      clear()
      const done = bold(`${finished}/${total}`)
      if (code == 130) return console.log(`${warning('Stopped')} · ${done} done, kept for next run`)
      if (code) return console.log(`${error('Build failed')} in ${success(failed)} · ${done} done`)
      for (const group of [...files.keys()]) block(group)
      console.log(total ? `Built in ${seconds()}` : 'Up to date')
    },
  }
}
