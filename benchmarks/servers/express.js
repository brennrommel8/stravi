import express from 'express'
import { pathToFileURL } from 'node:url'

const payload = Object.freeze({
  framework: 'express',
  ok: true,
  message: 'benchmark'
})

export async function startBenchServer(options = {}) {
  const port = Number(options.port ?? process.env.BENCH_PORT ?? 4302)
  const host = options.host ?? process.env.BENCH_HOST ?? '127.0.0.1'
  const app = express()

  app.get('/json', (_req, res) => {
    res.json(payload)
  })

  app.get('/text', (_req, res) => {
    res.type('text/plain').send('ok')
  })

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, host)

    const onListening = () => {
      instance.off('error', onError)
      resolve(instance)
    }

    const onError = (error) => {
      instance.off('listening', onListening)
      reject(error)
    }

    instance.once('listening', onListening)
    instance.once('error', onError)
  })

  const address = server.address()
  const resolvedPort = typeof address === 'object' && address ? address.port : port

  return {
    host,
    port: resolvedPort,
    stop() {
      return new Promise((resolve) => {
        server.close(() => resolve())
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

