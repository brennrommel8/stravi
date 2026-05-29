import { Stravi } from '../../dist/src/index.js'
import { pathToFileURL } from 'node:url'

const payload = Object.freeze({
  framework: 'stravi',
  ok: true,
  message: 'benchmark'
})

export async function startBenchServer(options = {}) {
  const port = Number(options.port ?? process.env.BENCH_PORT ?? 4301)
  const host = options.host ?? process.env.BENCH_HOST ?? '127.0.0.1'
  const app = new Stravi()

  app.get('/json', (sc) => sc.json(payload))
  app.get('/text', (sc) => sc.text('ok'))

  const server = app.start(port, host)
  await new Promise((resolve, reject) => {
    if (server.listening) {
      resolve(undefined)
      return
    }

    const onListening = () => {
      server.off('error', onError)
      resolve(undefined)
    }

    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }

    server.once('listening', onListening)
    server.once('error', onError)
  })

  const address = server.address()
  const resolvedPort = typeof address === 'object' && address ? address.port : port

  return {
    host,
    port: resolvedPort,
    async stop() {
      await app.stop()
    }
  }
}

async function shutdown() {
  if (state) await state.stop()
  process.exit(0)
}

let state = null

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  state = await startBenchServer()
  console.log(`ready:${state.port}`)
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

