const hold = setInterval(() => {}, 1000)
console.error('[benchmark] Electron wrapper started')
if (process.argv[2]) process.env.AGENTOS_BENCH_CREDENTIALS = process.argv[2]
if (process.argv[3]) process.env.AGENTOS_FINANCEBENCH_PATH = process.argv[3]
if (process.argv[4]) process.env.AGENTOS_BENCH_REPORT = process.argv[4]
if (process.argv[5] === 'deterministic') process.env.AGENTOS_BENCH_DETERMINISTIC = '1'

import('./verify-public-benchmarks.mjs').then(
  () => clearInterval(hold),
  error => {
    console.error(error)
    if (process.env.AGENTOS_BENCH_REPORT) require('node:fs').writeFileSync(`${process.env.AGENTOS_BENCH_REPORT}.progress`, `[benchmark] FAILED: ${error?.stack ?? error}\n`, { encoding: 'utf8', flag: 'a' })
    process.exitCode = 1
    clearInterval(hold)
  },
)
