#!/usr/bin/env bash
#
# A persistent, single-node MongoDB REPLICA SET for local development.
#
#   npm run db:up      start it (safe to run repeatedly)
#   npm run db:down    stop it
#
# Why this exists instead of pointing at whatever mongod is already running:
#
#   - This app needs a replica set. Assign, return, transfer and import commit
#     are multi-document transactions, and a standalone mongod rejects those at
#     RUNTIME — the app boots fine and then fails the first time you assign
#     something.
#   - It runs on 27018 with its own data directory, so it never touches a
#     mongod on 27017 that other projects on this machine depend on.
#   - Unlike `npm run dev:ephemeral`, data survives a restart, so an account
#     you create today still exists tomorrow.
#
# The Docker route (`npm run infra:up`) does the same thing in a container.
set -euo pipefail

PORT=27018
DIR="$(cd "$(dirname "$0")/.." && pwd)/.mongo"
LOG="$DIR/mongod.log"
PIDFILE="$DIR/mongod.pid"

command -v mongod >/dev/null || { echo "mongod not found — install with: brew install mongodb-community"; exit 1; }

if [[ "${1:-up}" == "down" ]]; then
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" && echo "Stopped MongoDB on $PORT."
  else
    echo "MongoDB on $PORT was not running."
  fi
  exit 0
fi

mkdir -p "$DIR/data"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "MongoDB already running on $PORT."
else
  mongod --replSet rs0 --port "$PORT" --bind_ip 127.0.0.1 \
    --dbpath "$DIR/data" --logpath "$LOG" --pidfilepath "$PIDFILE" --fork >/dev/null
  echo "Started MongoDB on $PORT (data in .mongo/)."
fi

# Initiate the replica set once. `hello.setName` is empty until it is, and the
# node refuses writes until it has elected itself primary — so wait for that too.
node -e "
const { MongoClient } = require('mongodb');
(async () => {
  const c = new MongoClient('mongodb://127.0.0.1:$PORT/?directConnection=true');
  await c.connect();
  const admin = c.db('admin');
  if (!(await admin.command({ hello: 1 })).setName) {
    await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:$PORT' }] } });
    console.log('Replica set rs0 initiated.');
  }
  for (let i = 0; i < 40; i++) {
    if ((await admin.command({ hello: 1 })).isWritablePrimary) { console.log('Ready.'); break; }
    await new Promise(r => setTimeout(r, 250));
  }
  await c.close();
})().catch(e => { console.error(e.message); process.exit(1); });
"
