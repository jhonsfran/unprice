export interface components {
  schemas: {
    ErrBadRequest: {
      error: {
        /**
         * @description A machine readable error code.
         * @example BAD_REQUEST
         * @enum {string}
         */
        code: "BAD_REQUEST"
        /**
         * @description A link to our documentation with more details about this error code
         * @example https://unprice.dev/docs/api-reference/errors/code/BAD_REQUEST
         */
        docs: string
        /** @description A human readable explanation of what went wrong */
        message: string
        /**
         * @description Please always include the requestId in your error report
         * @example req_1234
         */
        requestId: string
      }
    }
    ErrUnauthorized: {
      error: {
        /**
         * @description A machine readable error code.
         * @example UNAUTHORIZED
         * @enum {string}
         */
        code: "UNAUTHORIZED"
        /**
         * @description A link to our documentation with more details about this error code
         * @example https://unprice.dev/docs/api-reference/errors/code/UNAUTHORIZED
         */
        docs: string
        /** @description A human readable explanation of what went wrong */
        message: string
        /**
         * @description Please always include the requestId in your error report
         * @example req_1234
         */
        requestId: string
      }
    }
    ErrForbidden: {
      error: {
        /**
         * @description A machine readable error code.
         * @example FORBIDDEN
         * @enum {string}
         */
        code: "FORBIDDEN"
        /**
         * @description A link to our documentation with more details about this error code
         * @example https://unprice.dev/docs/api-reference/errors/code/FORBIDDEN
         */
        docs: string
        /** @description A human readable explanation of what went wrong */
        message: string
        /**
         * @description Please always include the requestId in your error report
         * @example req_1234
         */
        requestId: string
      }
    }
    ErrNotFound: {
      error: {
        /**
         * @description A machine readable error code.
         * @example NOT_FOUND
         * @enum {string}
         */
        code: "NOT_FOUND"
        /**
         * @description A link to our documentation with more details about this error code
         * @example https://unprice.dev/docs/api-reference/errors/code/NOT_FOUND
         */
        docs: string
        /** @description A human readable explanation of what went wrong */
        message: string
        /**
         * @description Please always include the requestId in your error report
         * @example req_1234
         */
        requestId: string
      }
    }
    ErrConflict: {
      error: {
        /**
         * @description A machine readable error code.
         * @example CONFLICT
         * @enum {string}
         */
        code: "CONFLICT"
        /**
         * @description A link to our documentation with more details about this error code
         * @example https://unprice.dev/docs/api-reference/errors/code/CONFLICT
         */
        docs: string
        /** @description A human readable explanation of what went wrong */
        message: string
        /**
         * @description Please always include the requestId in your error report
         * @example req_1234
         */
        requestId: string
      }
    }
    ErrTooManyRequests: {
      error: {
        /**
         * @description A machine readable error code.
         * @example TOO_MANY_REQUESTS
         * @enum {string}
         */
        code: "TOO_MANY_REQUESTS"
        /**
         * @description A link to our documentation with more details about this error code
         * @example https://unprice.dev/docs/api-reference/errors/code/TOO_MANY_REQUESTS
         */
        docs: string
        /** @description A human readable explanation of what went wrong */
        message: string
        /**
         * @description Please always include the requestId in your error report
         * @example req_1234
         */
        requestId: string
      }
    }
    ErrInternalServerError: {
      error: {
        /**
         * @description A machine readable error code.
         * @example INTERNAL_SERVER_ERROR
         * @enum {string}
         */
        code: "INTERNAL_SERVER_ERROR"
        /**
         * @description A link to our documentation with more details about this error code
         * @example https://unprice.dev/docs/api-reference/errors/code/INTERNAL_SERVER_ERROR
         */
        docs: string
        /** @description A human readable explanation of what went wrong */
        message: string
        /**
         * @description Please always include the requestId in your error report
         * @example req_1234
         */
        requestId: string
      }
    }
  }
}

/** Union of all API error response bodies (e.g. 400, 401, 404, 429, 500). */
export type ErrorResponse =
  | components["schemas"]["ErrBadRequest"]
  | components["schemas"]["ErrUnauthorized"]
  | components["schemas"]["ErrForbidden"]
  | components["schemas"]["ErrNotFound"]
  | components["schemas"]["ErrConflict"]
  | components["schemas"]["ErrTooManyRequests"]
  | components["schemas"]["ErrInternalServerError"]

/**
 * Union of all API error payloads (the `error` field in error responses).
 * Use this when narrowing on `result.error` to get typed `code`, `message`, `docs`, `requestId`.
 */
export type ApiError =
  | components["schemas"]["ErrBadRequest"]["error"]
  | components["schemas"]["ErrUnauthorized"]["error"]
  | components["schemas"]["ErrForbidden"]["error"]
  | components["schemas"]["ErrNotFound"]["error"]
  | components["schemas"]["ErrConflict"]["error"]
  | components["schemas"]["ErrTooManyRequests"]["error"]
  | components["schemas"]["ErrInternalServerError"]["error"]
  | {
      code: "FETCH_ERROR"
      message: string
      docs: string
      requestId: string
    }
export interface paths {
  "/test": {
    get: {
      responses: {
        /** @description The configured services and their status */
        200: {
          content: {
            "application/json": {
              /** @description The status of the server */
              status: string
              services: {
                /**
                 * @description The name of the connected metrics service
                 * @example AxiomMetrics
                 */
                metrics: string
                /**
                 * @description The name of the connected logger service
                 * @example evlog
                 */
                logger: string
                /** @description The name of the connected ratelimit service */
                ratelimit: string
                /** @description The name of the connected usagelimit service */
                usagelimit: string
                /** @description The name of the connected analytics service */
                analytics: string
              }
            }
          }
        }
        /** @description The server cannot or will not process the request due to something that is perceived to be a client error (e.g., malformed request syntax, invalid request message framing, or deceptive request routing). */
        400: {
          content: {
            "application/json": components["schemas"]["ErrBadRequest"]
          }
        }
        /** @description Although the HTTP standard specifies "unauthorized", semantically this response means "unauthenticated". That is, the client must authenticate itself to get the requested response. */
        401: {
          content: {
            "application/json": components["schemas"]["ErrUnauthorized"]
          }
        }
        /** @description The client does not have access rights to the content; that is, it is unauthorized, so the server is refusing to give the requested resource. Unlike 401 Unauthorized, the client's identity is known to the server. */
        403: {
          content: {
            "application/json": components["schemas"]["ErrForbidden"]
          }
        }
        /** @description The server cannot find the requested resource. In the browser, this means the URL is not recognized. In an API, this can also mean that the endpoint is valid but the resource itself does not exist. Servers may also send this response instead of 403 Forbidden to hide the existence of a resource from an unauthorized client. This response code is probably the most well known due to its frequent occurrence on the web. */
        404: {
          content: {
            "application/json": components["schemas"]["ErrNotFound"]
          }
        }
        /** @description This response is sent when a request conflicts with the current state of the server. */
        409: {
          content: {
            "application/json": components["schemas"]["ErrConflict"]
          }
        }
        /** @description The user has sent too many requests in a given amount of time ("rate limiting") */
        429: {
          content: {
            "application/json": components["schemas"]["ErrTooManyRequests"]
          }
        }
        /** @description The server has encountered a situation it does not know how to handle. */
        500: {
          content: {
            "application/json": components["schemas"]["ErrInternalServerError"]
          }
        }
      }
    }
  }
}
