import { beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import type { Server } from 'node:http';

/**
 * One listening HTTP server per test file.
 *
 * supertest's `request(app)` starts a fresh server and closes it for EVERY
 * call. Across this suite that is several thousand listen/close cycles in a
 * couple of minutes, each leaving a socket in TIME_WAIT — enough, on macOS, for
 * an occasional request to fail in ways that look nothing like the code under
 * test (a truncated response, an empty-bodied 404, a request that never
 * returns).
 *
 * Binding once per file and reusing it removes that entirely, and is faster.
 */
export function useTestServer(app: Express): () => Server {
  let server: Server;

  beforeAll(() => {
    // Port 0: let the OS pick a free one.
    server = app.listen(0);
    // Don't hold the process open if a file forgets to close it.
    server.unref();
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      }),
  );

  return () => server;
}
