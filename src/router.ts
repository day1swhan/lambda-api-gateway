import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

type Method = "HEAD" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
type Params = Record<string, string>;
type QueryString = Record<string, string>;
type Cookie = Record<string, string>;
type Token = { type: "static"; value: string } | { type: "param"; name: string };

type Context = { params: Params; query: QueryString; cookie: Cookie };
type Handler = (
  event: APIGatewayProxyEventV2,
  context: Context
) => APIGatewayProxyStructuredResultV2 | Promise<APIGatewayProxyStructuredResultV2>;
type ErrorHandler = (
  event: APIGatewayProxyEventV2,
  context: Context,
  error: any
) => APIGatewayProxyStructuredResultV2 | Promise<APIGatewayProxyStructuredResultV2>;

export type Middleware = (next: Handler) => Handler;

type MiddlewareWithPrefix = { prefix: string; middlewares: Middleware[] };

type Router = {
  method: Method;
  pathname: string;
  tokens: Token[];
  middlewares: Middleware[]; //라우터 전용 미들웨어
  handler: Handler;
};

type LambdaAPIGatewayConfig = {
  extended?: boolean;
};
type LambdaAPIGatewayHandler = {
  handler: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;
};

export class LambdaAPIGateway {
  private routes: Router[] = [];
  private middlewareStack: MiddlewareWithPrefix[] = [];
  private ignoreTrailingSlash = true;
  private onErrorHandler: ErrorHandler | null = null;

  constructor(config: LambdaAPIGatewayConfig = {}) {
    if (config.extended) {
      this.middlewareStack.push({ prefix: "/", middlewares: [requestIdMiddleware()] });
    }
  }

  use(prefixOrMw: string | Middleware, ...middlewares: Middleware[]) {
    if (typeof prefixOrMw === "string") {
      const prefix = normalizePrefix(prefixOrMw, this.ignoreTrailingSlash);
      if (!middlewares.length) {
        throw new Error("use(prefix, ...middlewares): at least one middleware required");
      }
      this.middlewareStack.push({ prefix, middlewares });
    } else {
      const list = [prefixOrMw, ...middlewares];
      this.middlewareStack.push({ prefix: "/", middlewares: list });
    }
    return this;
  }

  onError(errHandler: ErrorHandler) {
    this.onErrorHandler = errHandler;
    return this;
  }

  head(path: string, handler: Handler, ...middlewares: Middleware[]) {
    return this.add("HEAD", path, handler, middlewares);
  }
  get(path: string, handler: Handler, ...middlewares: Middleware[]) {
    return this.add("GET", path, handler, middlewares);
  }
  post(path: string, handler: Handler, ...middlewares: Middleware[]) {
    return this.add("POST", path, handler, middlewares);
  }
  put(path: string, handler: Handler, ...middlewares: Middleware[]) {
    return this.add("PUT", path, handler, middlewares);
  }
  patch(path: string, handler: Handler, ...middlewares: Middleware[]) {
    return this.add("PATCH", path, handler, middlewares);
  }
  delete(path: string, handler: Handler, ...middlewares: Middleware[]) {
    return this.add("DELETE", path, handler, middlewares);
  }
  options(path: string, handler: Handler, ...middlewares: Middleware[]) {
    return this.add("OPTIONS", path, handler, middlewares);
  }

  export(): LambdaAPIGatewayHandler {
    return {
      handler: (event: APIGatewayProxyEventV2) => this.handler(event),
    };
  }

  private add(method: Method, path: string, handler: Handler, middlewares: Middleware[]) {
    const pathname = normalizePath(path, this.ignoreTrailingSlash);
    const tokens = tokenize(pathname);
    this.routes.push({ method, pathname, tokens, handler, middlewares });
    return this;
  }

  private async handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
    const { rawPath, rawQueryString, headers, requestContext } = event;
    const { http } = requestContext;
    const method = http.method.toUpperCase() as Method;

    const pathname = normalizePath(rawPath, this.ignoreTrailingSlash);
    const parts = split(pathname);
    const query = parseQueryString(rawQueryString);
    const cookie = parseCookie(headers["cookie"] || "");

    let methodMismatch: Set<Method> | null = null;

    for (const route of this.routes) {
      const params = matchTokens(route.tokens, parts);
      if (!params) continue;

      if (route.method !== method) {
        methodMismatch ??= new Set();
        methodMismatch.add(route.method);
        continue;
      }

      // 전역 미들웨어부터 실행
      const globalChain = this.middlewareStack
        .filter((mw) => pathnameStartsWith(pathname, mw.prefix))
        .sort((a, b) => a.prefix.length - b.prefix.length)
        .flatMap((mw) => mw.middlewares);
      const middlewares: Middleware[] = [...globalChain, ...route.middlewares];

      const context: Context = { params, query, cookie };
      const userHandler: Handler = async (req, context) => route.handler(req, context);
      const handler = composeMiddleware(middlewares, userHandler);

      try {
        return await handler(event, context);
      } catch (err) {
        if (this.onErrorHandler) {
          return await this.onErrorHandler(event, context, err);
        }
        console.log(err);

        const body = { message: "Internal Server Error" };
        return {
          statusCode: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(body),
        };
      }
    }

    const middlewares: Middleware[] = this.middlewareStack
      .filter((mw) => pathnameStartsWith(pathname, mw.prefix))
      .sort((a, b) => a.prefix.length - b.prefix.length)
      .flatMap((mw) => mw.middlewares);

    const finalHandler: Handler = methodMismatch ? notAllowedHandler([...methodMismatch]) : notFoundHandler();

    const context: Context = { params: {}, query, cookie };
    const handler = composeMiddleware(middlewares, finalHandler);

    return handler(event, context);
  }
}

const notFoundHandler = (): Handler => async (event, context) => {
  const body = { message: "Not Found" };
  return {
    statusCode: 404,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
};

const notAllowedHandler =
  (methods: Method[]): Handler =>
  async (event, context) => {
    const body = { message: "Method Not Allowed" };
    return {
      statusCode: 405,
      headers: {
        Allow: methods.join(", "),
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    };
  };

const composeMiddleware = (middlewares: Middleware[], finalHandler: Handler): Handler => {
  const handler = middlewares.reduceRight((next, middleware) => {
    return middleware(next);
  }, finalHandler);
  return handler;
};

const requestIdMiddleware = (): Middleware => (next) => async (event, context) => {
  const start = Date.now();
  const uuid = crypto.randomUUID();

  const requestId = "x-request-id";
  const poweredBy = "x-powered-by";
  const duration = "x-duration-ms";

  event.headers = {
    ...event.headers,
    [requestId]: uuid,
  };

  const upstream = await next(event, context);

  upstream.headers = {
    ...upstream.headers,
    [requestId]: uuid,
    [poweredBy]: "day1swhan",
    [duration]: (Date.now() - start).toString(),
  };

  return upstream;
};

const tokenize = (path: string): Token[] => {
  const out: Token[] = [];
  const parts = split(path);
  for (const part of parts) {
    if (part.startsWith(":")) {
      const name = part.slice(1);

      if (!name) {
        throw new Error(`Invalid param in path "${path}"`);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Bad param name "${name}" in path "${path}"`);
      }
      out.push({ type: "param", name });
    } else {
      out.push({ type: "static", value: part });
    }
  }
  return out;
};

const split = (pathname: string): string[] => {
  return pathname
    .split("/")
    .map((d) => d.trim())
    .filter((d) => !!d);
};

const normalizePrefix = (p: string, ignoreTrailing: boolean): string => {
  if (!p.startsWith("/")) p = "/" + p;
  return normalizePath(p, ignoreTrailing);
};

const normalizePath = (p: string, ignoreTrailing: boolean): string => {
  if (!p) return "/";
  if (!p.startsWith("/")) p = "/" + p;
  if (ignoreTrailing && p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
  return p;
};

const pathnameStartsWith = (pathname: string, prefix: string) => {
  if (prefix === "/") return true;
  if (!pathname.startsWith(prefix)) return false;
  // /api, /api/xxxx 구분: 경계가 세그먼트 기준이어야됨
  return pathname.length === prefix.length || pathname[prefix.length] === "/";
};

const matchTokens = (tokens: Token[], parts: string[]): Params | null => {
  if (tokens.length !== parts.length) return null;

  const params: Params = {};
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const seg = parts[i];

    if (tk.type === "static") {
      if (tk.value !== seg) return null;
    } else {
      params[tk.name] = decode(seg);
    }
  }
  return params;
};

const parseQueryString = (rawQueryString: string): QueryString => {
  const init: QueryString = {};
  if (!rawQueryString) return init;

  const query = rawQueryString
    .replace(/^\?/, "")
    .split("&")
    .sort()
    .reduce((acc, part) => {
      const [k, v = null] = part.split("=");
      const key = decode(k);
      const value = v ? decode(v) : v;

      if (!value) return acc;
      acc[key] = value;

      return acc;
    }, init);

  return query;
};

const parseCookie = (rawCookie: string): Cookie => {
  const init: Cookie = {};
  if (!rawCookie) return init;

  const cookie = rawCookie
    .replace(/;/g, "")
    .split(" ")
    .sort()
    .reduce((acc, part) => {
      const [k, v = null] = part.split("=");
      const key = decode(k);
      const value = v ? decode(v) : v;

      if (!value) return acc;
      acc[key] = value;

      return acc;
    }, init);
  return cookie;
};

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
