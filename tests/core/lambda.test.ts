import { describe, it, expect } from 'vitest';
import type { Context } from 'aws-lambda';
import { handler, scheduled } from '../../src/lambda.js';

/**
 * The Lambda entry points, invoked the way AWS invokes them.
 *
 * The event is an API Gateway HTTP API (payload 2.0) request — the shape that
 * reaches the function behind CloudFront. What matters is that a request goes
 * through the real Express app and comes back as a Lambda response, that a warm
 * container reuses its boot, and that the jobs function returns a result
 * rather than hanging.
 */

function context(remainingMs = 60_000): Context {
  return {
    callbackWaitsForEmptyEventLoop: true,
    functionName: 'itam-api-test',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:ap-south-1:000000000000:function:itam-api-test',
    memoryLimitInMB: '1024',
    awsRequestId: 'test-request',
    logGroupName: '/aws/lambda/itam-api-test',
    logStreamName: 'stream',
    getRemainingTimeInMillis: () => remainingMs,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
  };
}

function httpEvent(path: string, method = 'GET') {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'api.example.com', 'x-forwarded-for': '203.0.113.7', accept: 'application/json' },
    requestContext: {
      accountId: '000000000000',
      apiId: 'api',
      domainName: 'api.example.com',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.7', userAgent: 'test' },
      requestId: 'req',
      routeKey: '$default',
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
  };
}

describe('the HTTP handler', () => {
  it('serves a request through the real app as a Lambda response', async () => {
    const ctx = context();
    const response = (await handler(httpEvent('/api/v1/health/live'), ctx)) as { statusCode: number; body: string };

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.status).toBe('ok');
    // Or every invocation waits on the idle database pool until it times out.
    expect(ctx.callbackWaitsForEmptyEventLoop).toBe(false);
  });

  it('answers a second request from the same warm container', async () => {
    const first = (await handler(httpEvent('/api/v1/health/live'), context())) as { statusCode: number };
    const second = (await handler(httpEvent('/api/v1/health/ready'), context())) as { statusCode: number };

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it('keeps the API envelope for an unknown route', async () => {
    const response = (await handler(httpEvent('/api/v1/nope'), context())) as { statusCode: number; body: string };
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).success).toBe(false);
  });
});

describe('the jobs handler', () => {
  it('runs due schedules and returns a result inside its budget', async () => {
    const started = Date.now();
    const result = await scheduled({ source: 'aws.events' }, context(45_000));

    expect(result).toHaveProperty('completed');
    expect(result).toHaveProperty('started');
    // A short remaining time must not turn into a negative budget or a hang.
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});
