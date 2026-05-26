import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { pathToFileURL } from 'node:url'

const payload = Object.freeze({
  framework: 'hono',
  ok: true,
  message: 'benchmark'
})

export async function startBenchServer(options = {}) {
  const port = Number(options.port || process.env.BENCH_PORT || 4303)
  const host = options.host || process.env.BENCH_HOST || '127.0.0.1'
  const app = new Hono()

  app.get('/json', (c) => c.json(payload))
  app.get('/text', (c) => c.text('ok'))

  let server = null
  await new Promise((resolve) => {
    server = serve(
      {
        fetch: app.fetch,
        port,
        hostname: host
      },
      () => resolve(undefined)
    )
  })

  return {
    host,
    port,
    stop() {
      return new Promise((resolve) => {
        if (server && typeof server.close === 'function') {
          server.close(() => resolve())
          return
        }
        resolve()
      })
    }
  }
}

let state = null

async function shutdown() {
  if (state) await state.stop()
  process.exit(0)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  state = await startBenchServer()
  console.log(`ready:${state.port}`)
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

