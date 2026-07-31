import * as readline from 'node:readline'

export function createRl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  })
}

export function askLine(
  rl: readline.Interface,
  prompt: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => resolve(ans ?? ''))
  })
}

/** 静默输入（不回显）；结束后换行 */
export async function askSecret(
  rl: readline.Interface,
  prompt: string,
): Promise<string> {
  // readline 与 raw mode 抢 stdin 时不稳：先 pause rl，再 raw 读
  rl.pause()
  process.stderr.write(prompt)
  const value = await readSilentLine()
  process.stderr.write('\n')
  rl.resume()
  return value
}

function readSilentLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    let buf = ''
    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const ch of s) {
        if (ch === '\n' || ch === '\r') {
          cleanup()
          resolve(buf)
          return
        }
        if (ch === '\u0003') {
          cleanup()
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1)
          continue
        }
        if (ch === '\u0015') {
          // Ctrl+U 清空行
          buf = ''
          continue
        }
        buf += ch
      }
    }
    const cleanup = () => {
      stdin.removeListener('data', onData)
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
    }
    stdin.on('data', onData)
  })
}

export function trimInput(raw: string): string {
  let v = raw.trim()
  if (
    (v.startsWith("'") && v.endsWith("'")) ||
    (v.startsWith('"') && v.endsWith('"'))
  ) {
    v = v.slice(1, -1)
  }
  return v
}

export function isYes(ans: string): boolean {
  const a = ans.trim().toLowerCase()
  return a === 'y' || a === 'yes'
}
