import { jsonContent } from "stoker/openapi/helpers"
import { z } from "zod"
import * as HttpStatusCodes from "~/util/http-status-codes"
import { errorSchemaFactory } from "./http"

export const openApiErrorResponses = {
  [HttpStatusCodes.BAD_REQUEST]: jsonContent(
    errorSchemaFactory(z.enum(["BAD_REQUEST"])).openapi("ErrBadRequest"),
    "The server cannot or will not process the request due to something that is perceived to be a client error (e.g., malformed request syntax, invalid request message framing, or deceptive request routing)."
  ),
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
    errorSchemaFactory(z.enum(["UNAUTHORIZED"])).openapi("ErrUnauthorized"),
    `Although the HTTP standard specifies "unauthorized", semantically this response means "unauthenticated". That is, the client must authenticate itself to get the requested response.`
  ),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(
    errorSchemaFactory(z.enum(["FORBIDDEN"])).openapi("ErrForbidden"),
    "The client does not have access rights to the content; that is, it is unauthorized, so the server is refusing to give the requested resource. Unlike 401 Unauthorized, the client's identity is known to the server."
  ),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    errorSchemaFactory(z.enum(["NOT_FOUND"])).openapi("ErrNotFound"),
    "The server cannot find the requested resource. In the browser, this means the URL is not recognized. In an API, this can also mean that the endpoint is valid but the resource itself does not exist. Servers may also send this response instead of 403 Forbidden to hide the existence of a resource from an unauthorized client. This response code is probably the most well known due to its frequent occurrence on the web."
  ),
  [HttpStatusCodes.CONFLICT]: jsonContent(
    errorSchemaFactory(z.enum(["CONFLICT"])).openapi("ErrConflict"),
    "This response is sent when a request conflicts with the current state of the server."
  ),
  [HttpStatusCodes.PRECONDITION_FAILED]: jsonContent(
    errorSchemaFactory(z.enum(["PRECONDITION_FAILED"])).openapi("ErrPreconditionFailed"),
    "The requested operation cannot be completed because certain conditions were not met. This typically occurs when a required resource state or version check fails."
  ),
  [HttpStatusCodes.PAYLOAD_TOO_LARGE]: jsonContent(
    errorSchemaFactory(z.enum(["PAYLOAD_TOO_LARGE"])).openapi("ErrPayloadTooLarge"),
    "The request payload is larger than the server is willing to process."
  ),
  [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
    errorSchemaFactory(z.enum(["TOO_MANY_REQUESTS"])).openapi("ErrTooManyRequests"),
    `The user has sent too many requests in a given amount of time ("rate limiting")`
  ),
  [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
    errorSchemaFactory(z.enum(["INTERNAL_SERVER_ERROR"])).openapi("ErrInternalServerError"),
    "The server has encountered a situation it does not know how to handle."
  ),
}
