import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'

export type MaybePromise<T> = T | Promise<T>
export type HeaderValue = string | undefined

export interface Validator<T> {
  parse(input: unknown, ...args: unknown[]): T
}

export type InferValidator<V> = V extends Validator<infer T> ? T : never

type StripQuery<Path extends string> = Path extends `${infer P}?${string}` ? P : Path

type ExtractParamKeys<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractParamKeys<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never

export type ParamsFromPath<Path extends string> = [ExtractParamKeys<StripQuery<Path>>] extends [never]
  ? Record<string, never>
  : {
      [K in ExtractParamKeys<StripQuery<Path>>]: string
    }

export interface CookieOptions {
  domain?: string
  expires?: Date
  httpOnly?: boolean
  maxAge?: number
  path?: string
  sameSite?: 'Strict' | 'Lax' | 'None'
  secure?: boolean
}

export interface CookieStore<TCookies extends Record<string, unknown> = Record<string, string | undefined>> {
  get<K extends keyof TCookies & string>(name: K): TCookies[K]
  get(name: string): string | undefined
  set(name: string, value: string, options?: CookieOptions): void
  delete(name: string, options?: CookieOptions): void
  all(): Readonly<Record<string, string>>
}

export type DefaultQuery = Record<string, string | undefined>
export type DefaultHeaders = Readonly<Record<string, HeaderValue>>
export type DefaultCookies = Record<string, string | undefined>

export type RouteSchema = {
  params?: Validator<Record<string, string>>
  query?: Validator<Record<string, unknown>>
  body?: Validator<unknown>
  headers?: Validator<Record<string, unknown>>
  cookies?: Validator<Record<string, unknown>>
}

type InferSchemaParams<Path extends string, Schema extends RouteSchema | undefined> =
  Schema extends { params: infer V }
    ? V extends Validator<unknown>
      ? InferValidator<V> & Record<string, string>
      : ParamsFromPath<Path>
    : ParamsFromPath<Path>

type InferSchemaQuery<Schema extends RouteSchema | undefined> =
  Schema extends { query: infer V }
    ? V extends Validator<unknown>
      ? InferValidator<V> & Record<string, unknown>
      : DefaultQuery
    : DefaultQuery

type InferSchemaBody<Schema extends RouteSchema | undefined> =
  Schema extends { body: infer V }
    ? V extends Validator<unknown>
      ? InferValidator<V>
      : unknown
    : unknown

type InferSchemaHeaders<Schema extends RouteSchema | undefined> =
  Schema extends { headers: infer V }
    ? V extends Validator<unknown>
      ? InferValidator<V> & Record<string, unknown>
      : DefaultHeaders
    : DefaultHeaders

type InferSchemaCookies<Schema extends RouteSchema | undefined> =
  Schema extends { cookies: infer V }
    ? V extends Validator<unknown>
      ? InferValidator<V> & Record<string, unknown>
      : DefaultCookies
    : DefaultCookies

export interface StravixContext<
  TParams extends Record<string, string> = Record<string, string>,
  TQuery extends Record<string, unknown> = DefaultQuery,
  TBody = unknown,
  THeaders extends Record<string, unknown> = DefaultHeaders,
  TCookies extends Record<string, unknown> = DefaultCookies,
  TEnv extends Readonly<Record<string, string | undefined>> = Readonly<Record<string, string | undefined>>
> {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: TParams
  env: TEnv
  state: Record<string, unknown>

  query(name?: string, defaultValue?: unknown): unknown
  body(): Promise<TBody>
  headers(name?: string): unknown

  cookies: CookieStore<TCookies>

  status(code: number): StravixContext<TParams, TQuery, TBody, THeaders, TCookies, TEnv>
  set(name: string, value: string): StravixContext<TParams, TQuery, TBody, THeaders, TCookies, TEnv>
  json(value: unknown, status?: number): undefined
  text(value: string, status?: number): undefined
  html(value: string, status?: number): undefined
}

export interface InternalStravixContext extends StravixContext {
  _commitCookies(): void
  _sendAuto(value: unknown, routeFound: boolean): void
  _allowedMethods(): string[]
  _setParams(value: Record<string, string>): void
  _setQuery(value: Record<string, unknown>): void
  _setHeaders(value: Record<string, unknown>): void
  _setCookies(value: Record<string, unknown>): void
  _setBody(value: unknown): void
}

export type Next = () => Promise<unknown>

export type Middleware<C extends StravixContext = StravixContext> = (svx: C, next?: Next) => MaybePromise<unknown>
export type Handler<C extends StravixContext = StravixContext> = (svx: C, next?: Next) => MaybePromise<unknown>
export type RouteFn<C extends StravixContext = StravixContext> = (svx: C, next?: Next) => MaybePromise<unknown>

export interface RouteMatch {
  handlers: RouteFn[]
  params: Record<string, string>
}

export interface CorsOptions {
  origin?: '*' | string | string[] | ((origin: string) => boolean)
  methods?: string[]
  headers?: string[] | string
  credentials?: boolean
  maxAge?: number
}

export type StravixOptions<TEnv extends Record<string, string> = Record<string, string>> = {
  env?: TEnv
}

export type RouteContextFrom<
  Path extends string,
  Schema extends RouteSchema | undefined,
  TEnv extends Readonly<Record<string, string | undefined>>
> = StravixContext<
  InferSchemaParams<Path, Schema>,
  InferSchemaQuery<Schema>,
  InferSchemaBody<Schema>,
  InferSchemaHeaders<Schema>,
  InferSchemaCookies<Schema>,
  TEnv
>

export type RouteHandler<
  Path extends string,
  Schema extends RouteSchema | undefined,
  TEnv extends Readonly<Record<string, string | undefined>>
> = RouteFn<RouteContextFrom<Path, Schema, TEnv>>

export type RouteMiddleware<
  Path extends string,
  Schema extends RouteSchema | undefined,
  TEnv extends Readonly<Record<string, string | undefined>>
> = RouteFn<RouteContextFrom<Path, Schema, TEnv>>

export type RouteHandlers<
  Path extends string,
  Schema extends RouteSchema | undefined,
  TEnv extends Readonly<Record<string, string | undefined>>
> = Array<RouteFn<RouteContextFrom<Path, Schema, TEnv>>>

export type RouteWithSchemaArgs<
  Path extends string,
  Schema extends RouteSchema,
  TEnv extends Readonly<Record<string, string | undefined>>
> = [schema: Schema, ...handlers: RouteHandlers<Path, Schema, TEnv>]

export type RouteWithoutSchemaArgs<
  Path extends string,
  TEnv extends Readonly<Record<string, string | undefined>>
> = RouteHandlers<Path, undefined, TEnv>

export type RouteMethod<TEnv extends Readonly<Record<string, string | undefined>>> = {
  <Path extends string>(path: Path, ...handlers: RouteWithoutSchemaArgs<Path, TEnv>): Stravix<TEnv>
  <Path extends string, Schema extends RouteSchema>(
    path: Path,
    ...args: RouteWithSchemaArgs<Path, Schema, TEnv>
  ): Stravix<TEnv>
}

export interface StravixInstance<TEnv extends Readonly<Record<string, string | undefined>>> {
  use(...fns: RouteFn[]): StravixInstance<TEnv>
  get: RouteMethod<TEnv>
  post: RouteMethod<TEnv>
  put: RouteMethod<TEnv>
  patch: RouteMethod<TEnv>
  delete: RouteMethod<TEnv>
  options: RouteMethod<TEnv>
  start(port?: number, host?: string): Server
  stop(): Promise<void>
}

export type NormalizedHeaders = Readonly<Record<string, HeaderValue>>
export type HeadersInput = IncomingHttpHeaders

export type EnvShape = Readonly<Record<string, string | undefined>>

export type Stravix<TEnv extends Readonly<Record<string, string | undefined>> = EnvShape> = StravixInstance<TEnv>


