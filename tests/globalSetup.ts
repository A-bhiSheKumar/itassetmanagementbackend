import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

/**
 * One MongoDB replica set for the whole run, started before any worker.
 *
 * A REPLICA SET, not a standalone: multi-document transactions are load-bearing
 * (assignment exclusivity, import commits) and a standalone mongod rejects them
 * at runtime. Tests passing against a standalone would be lying about production.
 */
let replSet: MongoMemoryReplSet | undefined;

export async function setup(project: TestProject): Promise<void> {
  replSet = await MongoMemoryReplSet.create({
    /**
     * A modest, explicit WiredTiger cache.
     *
     * The default is half of system RAM, which on a developer machine already
     * running other services leaves mongod competing for memory — and a
     * long-lived replica set that has churned through a few hundred tests then
     * stalls for a minute at a time on ordinary writes. Half a gigabyte is far
     * more than this suite needs.
     */
    instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.5'] }],
    replSet: {
      count: 1,
      storageEngine: 'wiredTiger',
      /**
       * A single-node replica set under sustained load occasionally steps down
       * and re-elects. With the 10s default election timeout, writes block long
       * enough to blow a test's deadline — which showed up as unrelated tests
       * timing out at random in long runs. Shorter timeouts recover in well
       * under a second.
       */
      configSettings: {
        electionTimeoutMillis: 500,
        heartbeatIntervalMillis: 100,
        heartbeatTimeoutSecs: 1,
      },
    },
  });
  project.provide('mongoUri', replSet.getUri());
}

export async function teardown(): Promise<void> {
  await replSet?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
