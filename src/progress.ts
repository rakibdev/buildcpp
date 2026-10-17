import type { Step } from './steps'

export const tty = Boolean(process.stdout.isTTY)

const paint = (code: number) => (text: string) => tty ? `\x1b[${code}m${text}\x1b[0m` : text
const bold = paint(1)
const dim = paint(2)
const red = paint(31)
const green = paint(32)
const yellow = paint(33)

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

// On a terminal: finished links, warnings and failures scroll above one status line redrawn 10×/s.
// Piped: one plain line per finished step.
export const progress = (total: number) => {
  const begin = performance.now()
  let running = 0
  let finished = 0
  let drawn = false

  const counter = () => `[${String(finished).padStart(String(total).length)}/${total}]`

  const clear = () => {
    if (drawn) process.stdout.write('\r\x1b[2K')
    drawn = false
  }

  const draw = () => {
    clear()
    process.stdout.write(`${bold(counter())} ${dim(`${running} running · ${seconds(performance.now() - begin)}`)}`)
    drawn = true
  }

  const print = (text: string) => {
    clear()
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  }

  const timer = tty && total ? setInterval(draw, 100) : undefined

  return {
    start: () => running++,
    finish: (step: Step, output: string) => {
      running--
      finished++
      if (output) print(`${yellow('⚠')} ${step.name}\n${output}`)
      if (!tty) print(`${counter()} ${step.label} ${step.name}`)
      else if (step.label == 'LINK' || step.label == 'AR') print(`${green('✓')} ${step.name}`)
    },
    fail: (step: Step, output: string) => {
      running--
      print(`${red('✗')} ${bold(step.name)}\n${output}`)
    },
    end: (code: number) => {
      clearInterval(timer)
      clear()
      const time = seconds(performance.now() - begin)
      if (code == 130) console.log(`${red('✗')} interrupted after ${finished}/${total} steps`)
      else if (code) console.log(`${red('✗')} build failed after ${finished}/${total} steps`)
      else console.log(`${green('✓')} ${total ? `${total} steps in ${time}` : 'up to date'}`)
    },
  }
}
