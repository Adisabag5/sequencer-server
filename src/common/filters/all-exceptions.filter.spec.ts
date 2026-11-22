import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { QueryFailedError } from 'typeorm';
import { AllExceptionsFilter, ErrorBody } from './all-exceptions.filter';

function hostFor(method = 'POST', url = '/api/auth/signup') {
  const json = jest.fn<void, [ErrorBody]>();
  const status = jest.fn().mockReturnValue({ json });

  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method, url }),
    }),
  } as unknown as ArgumentsHost;

  return { host, status, body: (): ErrorBody => json.mock.calls[0][0] };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let logged: jest.SpyInstance;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logged.mockRestore();
  });

  it('keeps the status and reason of a refusal', () => {
    const { host, status, body } = hostFor();

    filter.catch(new ConflictException('Email already registered'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(body().message).toBe('Email already registered');
    expect(body().error).toBe('Conflict');
  });

  it('preserves the array of validation messages', () => {
    // The frontend reads body.message to explain a 400 — api.errors.ts takes
    // the first entry. Flattening this into one tidy string would blank every
    // field-level message the person needs to see.
    const { host, body } = hostFor();

    filter.catch(
      new BadRequestException([
        'email must be an email',
        'password is too short',
      ]),
      host,
    );

    expect(body().message).toEqual([
      'email must be an email',
      'password is too short',
    ]);
  });

  it('passes a throttler refusal straight through', () => {
    const { host, status, body } = hostFor();

    filter.catch(new ThrottlerException(), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.TOO_MANY_REQUESTS);
    expect(body().statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  describe('an error from outside Nest that carries its own status', () => {
    /** body-parser's PayloadTooLargeError, in the shape Express throws it. */
    const payloadTooLarge = Object.assign(
      new Error('request entity too large'),
      {
        status: 413,
        statusCode: 413,
        expose: true,
        type: 'entity.too.large',
      },
    );

    it('keeps the status instead of flattening it to 500', () => {
      // This was a real regression: the filter turned Express's 413 into a 500,
      // reporting our bug where the caller had simply sent too much.
      const { host, status, body } = hostFor();

      filter.catch(payloadTooLarge, host);

      expect(status).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);
      expect(body().statusCode).toBe(413);
      expect(body().error).toBe('Payload Too Large');
    });

    it('passes its message through, because a 4xx is about the request', () => {
      const { host, body } = hostFor();

      filter.catch(payloadTooLarge, host);

      expect(body().message).toBe('request entity too large');
    });

    it('does not log it — the caller was told no, nothing broke', () => {
      const { host } = hostFor();

      filter.catch(payloadTooLarge, host);

      expect(logged).not.toHaveBeenCalled();
    });

    it('still says nothing when the carried status is a 5xx', () => {
      const { host, status, body } = hostFor();

      filter.catch(
        Object.assign(new Error('upstream exploded'), { status: 502 }),
        host,
      );

      expect(status).toHaveBeenCalledWith(502);
      expect(body().message).toBe('Internal server error');
    });

    it('ignores a status that is not a plausible one', () => {
      const { host, status } = hostFor();

      filter.catch(Object.assign(new Error('nonsense'), { status: 99 }), host);

      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });

  describe('something that is not an HttpException', () => {
    const driverError = new QueryFailedError(
      'SELECT * FROM users WHERE email = ?',
      ['adi@example.com'],
      new Error("Unknown column 'passwrd' in 'field list'"),
    );

    it('answers 500 and says nothing about why', () => {
      const { host, status, body } = hostFor();

      filter.catch(driverError, host);

      expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(body().message).toBe('Internal server error');

      // the query, the column name and the parameters are all in that error;
      // none of them belong in a response
      const sent = JSON.stringify(body());
      expect(sent).not.toContain('passwrd');
      expect(sent).not.toContain('SELECT');
      expect(sent).not.toContain('adi@example.com');
    });

    it('logs it with a stack, because a 500 is ours to fix', () => {
      const { host } = hostFor();

      filter.catch(driverError, host);

      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('/api/auth/signup'),
        expect.any(String),
      );
    });
  });

  it('does not log a refusal, which would only drown the log', () => {
    const { host } = hostFor();

    filter.catch(new ConflictException(), host);

    expect(logged).not.toHaveBeenCalled();
  });

  it('spells the reason the same way whichever layer refused', () => {
    // A guard's UnauthorizedException carries no `error` field, so the reason
    // is derived — and HttpStatus[401] is 'UNAUTHORIZED'. Without title-casing
    // that lands next to AuthService's 'Unauthorized' in the same API.
    const { host, body } = hostFor();

    filter.catch(new UnauthorizedException(), host);

    expect(body().error).toBe('Unauthorized');
  });

  it('title-cases a multi-word reason', () => {
    const { host, body } = hostFor();

    filter.catch(new NotFoundException(), host);

    expect(body().error).toBe('Not Found');
  });

  it('records where and when, for matching a report to a log line', () => {
    const { host, body } = hostFor('GET', '/api/beats/9');

    filter.catch(new ConflictException(), host);

    expect(body().path).toBe('/api/beats/9');
    expect(Number.isNaN(Date.parse(body().timestamp))).toBe(false);
  });
});
