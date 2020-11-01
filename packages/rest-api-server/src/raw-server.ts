import {
  createServer, IncomingMessage, ServerResponse
} from 'http'

import qs from 'qs'

import { ValidatorSpec, validate, serialize, TypeHint, SpecUnion, isField } from '@validator/validator/core'
import { Segment } from '@validator/validator/segmentChain'
import { Json } from '@validator/validator/Json'

interface MediaTypeProtocol {
  serialize(deserialized: Json): string
  deserialize(serialized: string): Json
}

class JsonProtocol implements MediaTypeProtocol {
  serialize = JSON.stringify;
  deserialize = JSON.parse;
}

type ServerConfig = {
  protocol: MediaTypeProtocol,
  encoding: BufferEncoding,
  port: number,
  frameworkErrorStatusCode: number,
  appErrorStatusCode: number,
  reportError: (error: unknown) => Promise<void>
}

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  protocol: new JsonProtocol(),
  encoding: 'utf-8',
  port: 8000,
  frameworkErrorStatusCode: 502,
  appErrorStatusCode: 500,
  reportError: (error: unknown) => {
    console.error(error)
    return Promise.resolve(undefined)
  }
}

const mergeServerConfigs = (
  serverConfig: Partial<ServerConfig>
): ServerConfig => ({
  ...DEFAULT_SERVER_CONFIG,
  ...serverConfig,
})

type KeysOfType<T, U> = { [K in keyof T]: T[K] extends U ? K : never }[keyof T];
type RequiredKeys<T> = Exclude<KeysOfType<T, Exclude<T[keyof T], undefined>>, undefined>;
type WithoutOptional<T> = Pick<T, RequiredKeys<T>>;

type HttpHeaders = Record<string, string | string[]>

type Optional<T> = T | undefined;

export type Request<PathParams, Data, QueryParams, Headers> = { method?: string }
  & WithoutOptional<{
    pathParams: PathParams,
    data: Data,
    headers: Headers,
    queryParams: QueryParams
  }>

export type Response<
  Data,
  Headers
> = { statusCode?: number }
  & WithoutOptional<{
    data: Data,
    headers: Headers,
  }>

type RequestSpec<
  RequestData extends Optional<unknown>,
  RequestQueryParams extends Optional<unknown>,
  RequestHeaders extends Optional<HttpHeaders>,
> = {
  data?: ValidatorSpec<RequestData>,
  query?: ValidatorSpec<RequestQueryParams>,
  headers?: ValidatorSpec<RequestHeaders>
}

type WildCardRequestSpec = RequestSpec<any, any, HttpHeaders>;

type ResponseSpec<
  ResponseData extends Optional<any> = undefined,
  ResponseHeaders extends Optional<HttpHeaders> = undefined
> = {
  data?: SpecUnion<ResponseData>,
  headers?: ValidatorSpec<ResponseHeaders>
}

type WildCardResponseSpec = ResponseSpec<any, HttpHeaders>;

type WildCardResponseSpecUnion = WildCardResponseSpec | NonNullable<SpecUnion<any>>;

type Route<
  RequestPathParams extends any,
  TResponseSpec extends WildCardResponseSpecUnion,
  TRequestSpec extends Optional<WildCardRequestSpec> = undefined,
> = {
  method?: string,
  pathSpec: Segment<RequestPathParams>,
  requestSpec?: TRequestSpec,
  responseSpec: TResponseSpec
  handler: (
    request: TRequestSpec extends WildCardRequestSpec ? Request<
      RequestPathParams,
      TypeHint<TRequestSpec['data']>,
      TypeHint<TRequestSpec['query']>,
      TypeHint<TRequestSpec['headers']>
    > : Request<RequestPathParams, never, never, never>
  ) => TResponseSpec extends WildCardResponseSpec ? Promise<Response<
      TypeHint<TResponseSpec['data']>,
      TypeHint<TResponseSpec['headers']>
    >
  > : TResponseSpec extends SpecUnion<any> ? Promise<TypeHint<TResponseSpec>> : Promise<undefined>
}

type WildCardRoute = Route<any, WildCardResponseSpecUnion, WildCardRequestSpec>

const matchRoute = (
  request: IncomingMessage,
  route: WildCardRoute
): boolean => {
  if (route.method && request.method !== route.method) {
    return false
  }
  try {
    route.pathSpec.match(request.url || '')
  } catch (err) {
    return false
  }
  return true
}

const getData = async (msg: IncomingMessage): Promise<string> => new Promise<string> ((resolve, reject) => {
  try {
    const chunks: string[] = []
    msg.on('readable', () => chunks.push(msg.read()))
    msg.on('error', reject)
    msg.on('end', () => resolve(chunks.join('')))
  } catch (err) {
    reject(err)
  }
})

const withAppErrorStatusCode = async <T>(statusCode: number, inner: () => Promise<T>): Promise<T> => {
  try {
    return await inner()
  } catch (error) {
    throw {
      statusCode: statusCode,
      error: error
    }
  }
}

const handleRoute = async (
  config: ServerConfig,
  route: WildCardRoute,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const [path, queryString] = (request.url || '').split('?', 2)

  const queryParams = route.requestSpec?.query
    ? validate(route.requestSpec.query, qs.parse(queryString))
    : undefined
  const pathParams = route.pathSpec.match(path)
  const method = request.method?.toUpperCase()
  const data = route.requestSpec?.data
    ? validate(route.requestSpec.data, config.protocol.deserialize(await getData(request)))
    : undefined
  const headers = route.requestSpec?.headers
    ? validate(route.requestSpec.headers, request.headers)
    : undefined

  const resp = await withAppErrorStatusCode(
    config.appErrorStatusCode,
    route.handler.bind(null, { method, pathParams, queryParams, data, headers })
  )

  Object.entries((resp as any).headers || {}).forEach(([key, value]) =>
    response.setHeader(key, value as any)
  )

  response.statusCode = resp.statusCode || data ? 200 : 201

  const dataSpec = isField(route.responseSpec) ? route.requestSpec : route.requestSpec?.data

  if (!dataSpec) {
    return
  }

  response.write(
    config.protocol.serialize(serialize(dataSpec, (resp as any).data)),
    config.encoding
  )

}

export const handle = async (
  config: ServerConfig,
  routes: WildCardRoute[],
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const route = routes.find(matchRoute.bind(null, request))
  if (route) {
    try {
      await handleRoute(config, route, request, response)
    } catch (error) {
      try {
        await config.reportError(error)
      } catch (reportingError) {
        console.error(reportingError)
      }
      response.statusCode = error.statusCode || config.frameworkErrorStatusCode
    }
  } else {
    response.statusCode = 404
  }
  response.end()
}

export type Method =
  'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'CONNECT' | 'OPTIONS' | 'TRACE' | 'PATCH' | string

type ResourceRoute<RequestPathParams> = Omit<
  Route<RequestPathParams, WildCardResponseSpec, WildCardRequestSpec>,
  'method' | 'pathSpec'
>

type Methods<RequestPathParams> =
  Record<Method, ResourceRoute<RequestPathParams>> |
  ResourceRoute<RequestPathParams>

const isResourceRoute = <RequestPathParams> (
  methods: Methods<RequestPathParams>
): methods is ResourceRoute<RequestPathParams> => typeof methods.handler === 'function'

export type Resource<RequestPathParams> = {
  pathSpec: Segment<RequestPathParams>,
  methods: Methods<RequestPathParams>
}

export const resource = <RequestPathParams> (
  pathSpec: Segment<RequestPathParams>,
  methods: Methods<RequestPathParams>
): Resource<RequestPathParams> => ({
    pathSpec, methods
  })

const toRoutes = (resources: Record<string, Resource<undefined>>): WildCardRoute[] => {
  const routes: WildCardRoute[] = []
  Object.values(resources).forEach(resource => {
    if (isResourceRoute(resource.methods)) {
      routes.push({
        method: undefined,
        pathSpec: resource.pathSpec,
        ...resource.methods
      })
    } else {
      Object.entries(resource.methods).forEach(([method, route]) => {
        routes.push({
          method: method,
          pathSpec: resource.pathSpec,
          ...route
        })
      })
    }
  })
  return routes
}

export const serve = (
  config: Partial<ServerConfig>,
  resources: Record<string, Resource<undefined>>,
): void => {
  const merged = mergeServerConfigs(config)
  createServer(handle.bind(null, merged, toRoutes(resources))).listen(merged.port)
}