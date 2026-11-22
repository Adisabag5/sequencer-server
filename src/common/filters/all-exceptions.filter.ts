import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/** getStatus() returns a number, so compare against one. */
const SERVER_ERROR: number = HttpStatus.INTERNAL_SERVER_ERROR;

/** The shape every error response has, whatever went wrong. */
export interface ErrorBody {
  statusCode: number;
  /**
   * Kept as-is from the exception — a string, or the array class-validator
   * produces. The frontend reads this field to explain a 400 to the person, so
   * replacing it with a tidier shape would silently blank those messages.
   */
  message: string | string[];
  error: string;
  path: string;
  timestamp: string;
}

/**
 * One shape for every error, and one place that decides what leaves the
 * building.
 *
 * Anything that is not an HttpException is a bug, not a refusal: it becomes a
 * flat 500 whose body says nothing, while the real error and its stack go to
 * the log. A TypeORM QueryFailedError, for instance, carries SQL and column
 * names — useful to us, a free schema tour for anyone else.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const status = statusFor(exception);

    const body: ErrorBody = {
      statusCode: status,
      message: messageFrom(exception, status),
      error: nameFor(exception, status),
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    // 5xx is ours to fix, so it gets a stack. 4xx is the client being told no,
    // which is routine and would only drown the log.
    if (status >= SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(body);
  }
}

/**
 * Not everything that reaches here is a Nest exception. Express middleware
 * throws plain errors that already carry an HTTP status — body-parser's
 * PayloadTooLargeError is a 413 — and flattening those to 500 both loses the
 * right answer and reports our bug where the caller made a mistake.
 *
 * Only a plausible status is trusted; anything else is a bug and stays a 500.
 */
function statusFor(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();

  const carried =
    (exception as { status?: unknown; statusCode?: unknown } | null) ?? {};
  const status =
    typeof carried.status === 'number' ? carried.status : carried.statusCode;

  return typeof status === 'number' && status >= 400 && status <= 599
    ? status
    : HttpStatus.INTERNAL_SERVER_ERROR;
}

/**
 * HttpException bodies come in two shapes: a bare string, or an object with
 * `message` (which ValidationPipe fills with an array).
 */
function messageFrom(exception: unknown, status: number): string | string[] {
  if (!(exception instanceof HttpException)) {
    // A 4xx from outside Nest is still the caller being told about their own
    // request, so its message is safe and useful — body-parser's "request
    // entity too large" being the one that turns up in practice. 5xx keeps
    // saying nothing.
    const message = (exception as { message?: unknown } | null)?.message;

    return status < SERVER_ERROR && typeof message === 'string'
      ? message
      : 'Internal server error';
  }

  const payload = exception.getResponse();

  if (typeof payload === 'string') return payload;

  const message = (payload as { message?: unknown }).message;

  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map(String);

  return defaultReason(status);
}

function nameFor(exception: unknown, status: number): string {
  if (!(exception instanceof HttpException)) return defaultReason(status);

  const payload = exception.getResponse();

  if (typeof payload === 'object') {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string') return error;
  }

  return defaultReason(status);
}

/**
 * HttpStatus[404] is 'NOT_FOUND', but Nest's own exceptions carry 'Not Found'.
 * Title-casing here keeps one spelling across every response — otherwise the
 * reason reads differently depending on which layer refused, which is exactly
 * the inconsistency this filter exists to remove.
 */
function defaultReason(status: number): string {
  const name = HttpStatus[status] as string | undefined;
  if (name === undefined) return 'Error';

  return name
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
