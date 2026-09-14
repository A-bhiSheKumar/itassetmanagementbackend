import type { Context } from 'aws-lambda';

/**
 * AWS Lambda entry points (ADR-017).
 *
 *   handler    — the HTTP API, behind API Gateway and CloudFront.
 *   scheduled  — the jobs function: EventBridge every minute, and a wake-up
 *                invoke whenever a job is queued. Runs due schedules, then
 *                drains the queue until its time budget is spent.
 *
 * The same modules and services as `main.ts` and `worker.ts`; only the edges
 * differ. There is no second implementation of anything.
 *
 * ── Why everything below is imported dynamically ──────────────────────────
 * Configuration is validated the moment `config/env.ts` is first imported. On
 * Lambda the secrets it needs (the database URI, JWT secrets, the Resend key)
 * are fetched from Secrets Manager at cold start — so they must be in
 * `process.env` BEFORE any application module is imported. A static import
 * would validate an empty environment and fail every cold start.
 */

type Json = Record<string, unknown>;

interface Booted {
  httpHandler: (event: unknown, context: Context) => Promise<unknown>;
  runJobs: (budgetMs: number) => Promise<Json>;
}

let booting: Promise<Booted> | null = null;

async function loadSecrets(): Promise<void> {
  const secretId = process.env.SECRETS_ID;
  if (!secretId) return;

  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));

  const values = JSON.parse(result.SecretString ?? '{}') as Record<string, string>;
  for (const [key, value] of Object.entries(values)) {
    // Never overwrite a variable the function was given directly — that is how
    // a deploy deliberately overrides a single value without editing the secret.
    process.env[key] ??= value;
  }
}

function boot(): Promise<Booted> {
  booting ??= (async () => {
    await loadSecrets();

    const [{ createApp }, db, jobs, http, composition, subscribers, { logger }] = await Promise.all([
      import('./app.js'),
      import('./core/db/index.js'),
      import('./core/jobs/index.js'),
      import('./core/http/index.js'),
      import('./jobs.js'),
      import('./subscribers.js'),
      import('./core/logging/index.js'),
    ]);
    const { default: serverless } = await import('serverless-http');
    const { env } = await import('./config/index.js');

    await db.connectDatabase();
    subscribers.registerEventSubscribers();
    http.setRateLimitStore('shared', new http.MongoRateLimitStore());

    const queue = await jobs.initJobQueue();
    composition.registerJobHandlers();

    /*
     * Wake the jobs function when work is queued, so an import the user just
     * started runs now rather than at the next minute's schedule. Fire-and-
     * forget by design: if the invoke fails, the scheduled drain still runs it.
     */
    if (env.JOBS_FUNCTION_NAME) {
      const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
      const lambda = new LambdaClient({});
      jobs.setJobKicker(async (queueName) => {
        await lambda.send(
          new InvokeCommand({
            FunctionName: env.JOBS_FUNCTION_NAME,
            InvocationType: 'Event',
            Payload: Buffer.from(JSON.stringify({ source: 'itam.kick', queue: queueName })),
          }),
        );
      });
    }

    const app = createApp();
    const httpHandler = serverless(app, {
      // Downloads that are not JSON (the import template) must survive the trip
      // through API Gateway intact.
      binary: ['application/octet-stream', 'text/csv', 'application/pdf', 'image/*'],
    }) as unknown as Booted['httpHandler'];

    const runJobs: Booted['runJobs'] = async (budgetMs) => {
      const started = await composition.runDueSchedules();
      const drained = await queue.drain({ budgetMs });
      logger.info({ started, ...drained }, 'Jobs invocation finished');
      return { started, ...drained };
    };

    return { httpHandler, runJobs };
  })().catch((err) => {
    // A failed cold start must not be cached, or every later invocation in this
    // container would fail the same way without retrying.
    booting = null;
    throw err;
  });

  return booting;
}

export async function handler(event: unknown, context: Context): Promise<unknown> {
  // Pooled connections keep the event loop busy; without this Lambda would wait
  // for them to close and every request would time out.
  context.callbackWaitsForEmptyEventLoop = false;

  const { httpHandler } = await boot();
  return httpHandler(event, context);
}

/**
 * The jobs function.
 *
 * The budget leaves 30 seconds before Lambda's hard timeout: a job claimed near
 * the end must still have time to finish, because a job killed mid-run is only
 * recovered after its lease lapses — minutes later.
 */
export async function scheduled(_event: unknown, context: Context): Promise<Json> {
  context.callbackWaitsForEmptyEventLoop = false;

  const { runJobs } = await boot();
  const remaining = typeof context.getRemainingTimeInMillis === 'function' ? context.getRemainingTimeInMillis() : 60_000;

  return runJobs(Math.max(5_000, remaining - 30_000));
}
