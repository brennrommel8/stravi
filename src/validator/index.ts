import type { Validator } from '../core/types.js'

class ValidationError extends Error {
  issues: string[]

  constructor(issues: string[]) {
    super(`Validation failed: ${issues.join('; ')}`)
    this.name = 'ValidationError'
    this.issues = issues
  }
}

function issue(path: string, message: string): string {
  return path ? `${path}: ${message}` : message
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class StringValidator implements Validator<string> {
  private readonly minLen?: number

  constructor(minLen?: number) {
    this.minLen = minLen
  }

  min(length: number): StringValidator {
    return new StringValidator(length)
  }

  parse(input: unknown, path = ''): string {
    if (typeof input !== 'string') {
      throw new ValidationError([issue(path, 'expected string')])
    }

    if (this.minLen != null && input.length < this.minLen) {
      throw new ValidationError([issue(path, `must have at least ${this.minLen} characters`)])
    }

    return input
  }
}

class NumberValidator implements Validator<number> {
  private readonly mustInt: boolean

  constructor(mustInt = false) {
    this.mustInt = mustInt
  }

  int(): NumberValidator {
    return new NumberValidator(true)
  }

  parse(input: unknown, path = ''): number {
    if (typeof input !== 'number' || Number.isNaN(input)) {
      throw new ValidationError([issue(path, 'expected number')])
    }

    if (this.mustInt && !Number.isInteger(input)) {
      throw new ValidationError([issue(path, 'expected integer')])
    }

    return input
  }
}

class BooleanValidator implements Validator<boolean> {
  parse(input: unknown, path = ''): boolean {
    if (typeof input !== 'boolean') {
      throw new ValidationError([issue(path, 'expected boolean')])
    }

    return input
  }
}

class OptionalValidator<T> implements Validator<T | undefined> {
  private readonly inner: Validator<T>

  constructor(inner: Validator<T>) {
    this.inner = inner
  }

  parse(input: unknown, path = ''): T | undefined {
    if (input === undefined || input === null) return undefined
    return this.inner.parse(input, path)
  }
}

class ArrayValidator<T> implements Validator<T[]> {
  private readonly inner: Validator<T>

  constructor(inner: Validator<T>) {
    this.inner = inner
  }

  parse(input: unknown, path = ''): T[] {
    if (!Array.isArray(input)) {
      throw new ValidationError([issue(path, 'expected array')])
    }

    return input.map((value, index) => this.inner.parse(value, `${path}[${index}]`))
  }
}

type Shape = Record<string, Validator<unknown>>
type InferShape<S extends Shape> = {
  [K in keyof S]: S[K] extends Validator<infer T> ? T : never
}

class ObjectValidator<S extends Shape> implements Validator<InferShape<S>> {
  private readonly shape: S

  constructor(shape: S) {
    this.shape = shape
  }

  parse(input: unknown, path = ''): InferShape<S> {
    if (!isObject(input)) {
      throw new ValidationError([issue(path, 'expected object')])
    }

    const out: Record<string, unknown> = {}
    const issues: string[] = []

    for (const [key, validator] of Object.entries(this.shape)) {
      const nextPath = path ? `${path}.${key}` : key
      try {
        out[key] = validator.parse(input[key], nextPath)
      } catch (error) {
        if (error instanceof ValidationError) {
          issues.push(...error.issues)
        } else {
          issues.push(issue(nextPath, 'invalid value'))
        }
      }
    }

    if (issues.length > 0) {
      throw new ValidationError(issues)
    }

    return out as InferShape<S>
  }
}

class EnumValidator<T extends readonly string[]> implements Validator<T[number]> {
  private readonly values: Set<string>

  constructor(values: T) {
    this.values = new Set(values)
  }

  parse(input: unknown, path = ''): T[number] {
    if (typeof input !== 'string' || !this.values.has(input)) {
      throw new ValidationError([issue(path, 'expected enum value')])
    }

    return input as T[number]
  }
}

export const v = {
  string(): StringValidator {
    return new StringValidator()
  },

  number(): NumberValidator {
    return new NumberValidator()
  },

  boolean(): BooleanValidator {
    return new BooleanValidator()
  },

  optional<T>(validator: Validator<T>): Validator<T | undefined> {
    return new OptionalValidator(validator)
  },

  array<T>(validator: Validator<T>): Validator<T[]> {
    return new ArrayValidator(validator)
  },

  object<S extends Shape>(shape: S): Validator<InferShape<S>> {
    return new ObjectValidator(shape)
  },

  enum<const T extends readonly string[]>(values: T): Validator<T[number]> {
    return new EnumValidator(values)
  }
}

export default v
export { ValidationError }
export type { Validator }
