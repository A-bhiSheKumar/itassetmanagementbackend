/* eslint-disable no-console */
import { createApp } from '../../src/app.js';
import { collectRoutes } from './routeTable.js';

for (const r of collectRoutes(createApp())) {
  console.log(
    `${r.method.padEnd(6)} ${r.path.padEnd(32)} ${
      r.guard?.permission ?? (r.guard?.public ? 'PUBLIC' : r.guard?.authenticatedOnly ? 'AUTH' : '** NONE **')
    }`,
  );
}
