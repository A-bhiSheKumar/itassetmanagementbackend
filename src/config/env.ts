import { z } from 'zod';

/**
 * Environment schema.
 *
 * Validated once, at boot. A missing or malformed variable stops the process
 * immediately with a readable message — rather than surfacing at 3am on the
 * first request that happens to need it.
 */
const durationString = z.string().regex(/^\d+[smhd]$/, 'expected a duration like 15m, 24h, 30d');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: durationString.default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  /**
   * Where uploaded files live. `local` writes under `.storage/` for development
   * and tests; `s3` is Amazon S3 (or MinIO locally, via S3_ENDPOINT).
   */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  /** Optional: only for an S3-compatible store that is not AWS, such as MinIO. */
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  /**
   * Optional on AWS, where Lambda's IAM role supplies credentials. Only set for
   * MinIO or a laptop — a long-lived key in production is one more secret to leak.
   */
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * How many proxies sit between the client and Express, for `req.ip`.
   *
   * Per-IP rate limits and the audit log both depend on it. Behind CloudFront
   * and API Gateway the right value must be confirmed against real traffic —
   * too low and every request appears to come from one edge address, collapsing
   * the per-IP limit onto everybody at once.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  /**
   * MongoDB pool size per process. On Lambda each container serves one request
   * at a time, so a large pool only multiplies connections against Atlas's
   * per-tier ceiling; the default drops accordingly.
   */
  MONGO_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).optional(),

  /** The jobs function to wake after an enqueue, on Lambda. Unset elsewhere. */
  JOBS_FUNCTION_NAME: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.STORAGE_DRIVER === 's3') {
    for (const key of ['S3_BUCKET', 'S3_REGION'] as const) {
      if (!value[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when STORAGE_DRIVER=s3` });
    }
  }

  /*
   * Refused, not warned. On Lambda the filesystem is read-only outside /tmp and
   * wiped between containers, so a production deploy on the local driver would
   * accept uploads and lose every one of them — with no error anywhere.
   */
  if (value.NODE_ENV === 'production' && value.STORAGE_DRIVER !== 's3') {
    ctx.addIssue({ code: 'custom', path: ['STORAGE_DRIVER'], message: 'must be s3 in production' });
  }
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    const message = `Invalid environment configuration:\n${issues}`;

    // On Lambda, throw: exiting the process during init kills the container
    // with a generic runtime error, while a thrown error is reported with this
    // message in CloudWatch and marks the invocation failed.
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) throw new Error(message);

    // Deliberately process.stderr, not the logger — the logger depends on config,
    // and this is the one failure that must be readable before anything is wired up.
    process.stderr.write(`\n${message}\n\n`);
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';
/** True inside an AWS Lambda runtime. */
export const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
