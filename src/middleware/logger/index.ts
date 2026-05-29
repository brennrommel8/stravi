import type { Middleware } from '../../core/types.js'

export type Logger = {
  error: (message: string) => void
  info: (message: string) => void
}

export type LoggerOptions = {
  logger?: Logger
}

export default function logger(options: LoggerOptions = {}): Middleware {
  const sink: Logger = options.logger || console

  return async function loggerMiddleware(sc, next) {
    const startedAt = process.hrtime.bigint()
    const method = sc.req.method || 'GET'
    const path = sc.path

    sc.res.once('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
      const status = sc.res.statusCode
      sink.info(`${method} ${path} ${status} ${elapsedMs.toFixed(2)}ms`)
    })

    try {
      if (!next) return undefined
      return await next()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sink.error(`${method} ${path} ERROR ${message}`)
      throw error
    }
  }
}
