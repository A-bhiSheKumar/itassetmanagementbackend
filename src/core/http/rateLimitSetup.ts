import IORedis from 'ioredis';
import { env, isProduction } from '../../config/index.js';
import { logger } from '../logging/index.js';
import { setRateLimitStore } from './middleware/rateLimit.middleware.js';
import { RedisRateLimitStore } from './middleware/redisRateLimitStore.js';

/**
 * Points the limiter at Redis when there is one.
 *
 * Optional in development, where a single process makes shared counters
 * pointless. In production it is worth being loud about: without it the
 * published limits are wrong by a factor of however many replicas are running,
 * which is the kind of thing that is only noticed during an incident.
 */
export async function configureRateLimitStore(): Promise<void> {
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    connectTimeout: 2_000,
    lazyConnect: true,
    // Keep trying, but never faster than every few seconds: the limiter fails
    // open, so a reconnect storm would cost more than the outage.
    retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
  });

  // An expected connection failure is the question being asked, not an
  // incident. Without a listener ioredis prints "Unhandled error event".
  client.on('error', () => undefined);

  try {
    await client.connect();
    await client.ping();

    setRateLimitStore(new RedisRateLimitStore(client));
    logger.info('Rate limiting is shared across replicas');
  } catch {
    client.disconnect();

    if (isProduction) {
      logger.error(
        { url: env.REDIS_URL },
        'Redis unavailable for rate limiting — limits are PER REPLICA, so the effective ' +
          'limit is multiplied by the replica count',
      );
    } else {
      logger.debug('No Redis — rate limiting is in-process');
    }
  }
}
