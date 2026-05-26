import type { Middleware } from '../../../core/src/types.js'

export type Logger = {
  error: (message: string) => void
  info: (message: string) => void
}

export type LoggerOptions = {
  logger?: Logger
}

export default function logger(options: LoggerOptions = {}): Middleware {
  const sink: Logger = options.logger || console

  return async function loggerMiddleware(svx, next) {
    const startedAt = process.hrtime.bigint()
    const method = svx.req.method || 'GET'
    const path = svx.url.pathname

    svx.res.once('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
      const status = svx.res.statusCode
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
