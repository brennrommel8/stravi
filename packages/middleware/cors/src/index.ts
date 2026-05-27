import type { CorsOptions, Middleware } from '../../../core/src/types.js'

const DEFAULT_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

function originAllowed(originConfig: CorsOptions['origin'], requestOrigin: string): boolean {
  if (!originConfig) return false
  if (originConfig === '*') return true
  if (typeof originConfig === 'string') return originConfig === requestOrigin
  if (Array.isArray(originConfig)) return originConfig.includes(requestOrigin)
  if (typeof originConfig === 'function') return Boolean(originConfig(requestOrigin))
  return false
}

export default function cors(options: CorsOptions = {}): Middleware {
  const {
    origin = '*',
    methods = DEFAULT_METHODS,
    headers,
    credentials = false,
    maxAge
  } = options

  const allowMethods = methods.join(', ')
  const allowHeaders = Array.isArray(headers) ? headers.join(', ') : headers

  return async function corsMiddleware(sc, next) {
    const requestOriginHeader = sc.headers('origin')
    const requestOrigin = typeof requestOriginHeader === 'string' ? requestOriginHeader : ''

    if (origin === '*') {
      sc.set('Access-Control-Allow-Origin', '*')
    } else if (requestOrigin && originAllowed(origin, requestOrigin)) {
      sc.set('Access-Control-Allow-Origin', requestOrigin)
      sc.set('Vary', 'Origin')
    }

    sc.set('Access-Control-Allow-Methods', allowMethods)

    if (allowHeaders) {
      sc.set('Access-Control-Allow-Headers', allowHeaders)
    } else {
      const requestHeadersHeader = sc.headers('access-control-request-headers')
      const requestHeaders = typeof requestHeadersHeader === 'string' ? requestHeadersHeader : undefined
      if (requestHeaders) {
        sc.set('Access-Control-Allow-Headers', requestHeaders)
      }
    }

    if (maxAge != null) {
      sc.set('Access-Control-Max-Age', String(maxAge))
    }

    if (credentials) {
      sc.set('Access-Control-Allow-Credentials', 'true')
    }

    if (sc.req.method === 'OPTIONS') {
      sc.status(204)
      return sc.text('')
    }

    if (!next) return undefined
    return next()
  }
}

