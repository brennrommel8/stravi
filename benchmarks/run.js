import process from 'node:process'
import autocannon from 'autocannon'
import { startBenchServer as startStravixServer } from './servers/stravix.js'
import { startBenchServer as startExpressServer } from './servers/express.js'
import { startBenchServer as startHonoServer } from './servers/hono.js'

const defaults = {
  duration: 15,
  connections: 100,
  pipelining: 10,
  endpoint: '/json',
  rounds: 1
}

const benchmarks = [
  { name: 'stravix', port: 4301, start: startStravixServer },
  { name: 'express', port: 4302, start: startExpressServer },
  { name: 'hono', port: 4303, start: startHonoServer }
]

function readArg(name, fallback) {
  const idx = process.argv.indexOf(name)
  if (idx === -1) return fallback
  const value = process.argv[idx + 1]
  if (!value) return fallback
  return value
}

function toNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function formatNumber(value, digits = 2) {
  return Number(value).toFixed(digits)
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

function runAutocannon(url, options) {
  return new Promise((resolve, reject) => {
    autocannon(
      {
        url,
        connections: options.connections,
        duration: options.duration,
        pipelining: options.pipelining
      },
      (err, result) => {
        if (err) reject(err)
        else resolve(result)
      }
    )
  })
}

function printSummary(results) {
  console.log('\nBenchmark Summary')
  console.log('framework  req/s(avg)  latency(ms avg)  latency p99(ms)  throughput(MB/s)  errors  timeouts')

  for (const row of results) {
    console.log(
      `${row.framework.padEnd(9)}  ${String(Math.round(row.reqPerSec)).padStart(10)}  ${formatNumber(row.latencyAvg).padStart(15)}  ${formatNumber(row.latencyP99).padStart(15)}  ${formatNumber(row.throughputMB).padStart(16)}  ${String(row.errors).padStart(6)}  ${String(row.timeouts).padStart(8)}`
    )
  }
}

async function main() {
  const options = {
    duration: toNumber(readArg('--duration', defaults.duration), defaults.duration),
    connections: toNumber(readArg('--connections', defaults.connections), defaults.connections),
    pipelining: toNumber(readArg('--pipelining', defaults.pipelining), defaults.pipelining),
    endpoint: readArg('--endpoint', defaults.endpoint),
    rounds: toNumber(readArg('--rounds', defaults.rounds), defaults.rounds)
  }

  console.log(
    `Running benchmarks: duration=${options.duration}s connections=${options.connections} pipelining=${options.pipelining} endpoint=${options.endpoint} rounds=${options.rounds}`
  )

  const results = []

  for (const entry of benchmarks) {
    const rounds = []

    for (let i = 0; i < options.rounds; i += 1) {
      const server = await entry.start({ port: entry.port, host: '127.0.0.1' })
      const url = `http://127.0.0.1:${entry.port}${options.endpoint}`

      try {
        const result = await runAutocannon(url, options)
        rounds.push({
          reqPerSec: result.requests.average,
          latencyAvg: result.latency.average,
          latencyP99: result.latency.p99,
          throughputMB: result.throughput.average / 1024 / 1024,
          errors: result.errors,
          timeouts: result.timeouts
        })
        console.log(
          `${entry.name} [${i + 1}/${options.rounds}]: req/s=${Math.round(result.requests.average)} latency(avg)=${formatNumber(result.latency.average)}ms p99=${formatNumber(result.latency.p99)}ms`
        )
      } finally {
        await server.stop()
      }
    }

    results.push({
      framework: entry.name,
      reqPerSec: median(rounds.map((row) => row.reqPerSec)),
      latencyAvg: median(rounds.map((row) => row.latencyAvg)),
      latencyP99: median(rounds.map((row) => row.latencyP99)),
      throughputMB: median(rounds.map((row) => row.throughputMB)),
      errors: median(rounds.map((row) => row.errors)),
      timeouts: median(rounds.map((row) => row.timeouts))
    })
  }

  printSummary(results)
}

main().catch((error) => {
  console.error('Benchmark failed:', error.message)
  process.exit(1)
})
