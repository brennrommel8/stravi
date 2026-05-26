import { STATUS_CODES } from 'node:http'

export class HttpError extends Error {
  readonly status: number
  readonly details?: unknown

  constructor(status: number, message?: string, details?: unknown) {
    super(message || STATUS_CODES[status] || 'Error')
    this.name = 'HttpError'
    this.status = status
    this.details = details
  }
}

// Backward compatibility aliases
export class HttpException extends HttpError {}
export class StravixError extends HttpError {}
