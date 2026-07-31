import { spawnSync, type SpawnSyncOptions } from 'node:child_process'

export type RunResult = {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

export function run(
  command: string,
  args: string[],
  opts: SpawnSyncOptions = {},
): RunResult {
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    ...opts,
  })
  return {
    status: r.status,
    stdout: r.stdout?.toString() ?? '',
    stderr: r.stderr?.toString() ?? '',
    error: r.error,
  }
}

/** 丢弃 stdout/stderr（s deploy 防泄密） */
export function runDiscarded(
  command: string,
  args: string[],
  opts: SpawnSyncOptions = {},
): number {
  const r = spawnSync(command, args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    ...opts,
  })
  if (r.error) return 1
  return r.status ?? 1
}

export function which(cmd: string): boolean {
  const r = spawnSync(cmd, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // some CLIs use -v / 不同退出码；只要能找到可执行文件
  if (r.error) {
    const r2 = spawnSync('bash', ['-lc', `command -v ${cmd}`], {
      encoding: 'utf8',
    })
    return (r2.status ?? 1) === 0
  }
  return true
}
