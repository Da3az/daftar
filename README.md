# daftar

**A crypto brokerage on a double-entry ledger that is correct under
concurrency — and the measurements that prove it, including the ones that went
against me.**

دفتر — "ledger". The name is the thesis: the ledger is not a feature of this
system, it is the system.

```
1,718 orders/s      p99 125.7 ms       0% errors        advisory locks, 1,000 accounts
  878 orders/s      p99 103.8 ms      25.5% errors      serializable + retry, same load
```

Both rows are the same code on the same box under the same load, with one
request header changed. The second row has the **better** p99 and is the worse
result.

Every number in this repository was measured on a named box against an asserted
dataset, and the load scripts that produced them are in [`load/`](load/). The
claim is not "this is fast" — it is **"this does not lose money, and here is the cost of
that."**

---

## The four results worth your time

### 1. The naive ledger loses money, and it is still runnable

Both broken implementations are permanent, flag-gated code paths — not a story
about code that used to exist. 500 concurrent debits of 1.00 against a balance
that covers exactly 100:

| Path                | Applied        | Final balance | What happened                                         |
| ------------------- | -------------- | ------------- | ----------------------------------------------------- |
| `naive_overdraft`   | 159 of 500     | **−59.00**    | overdrawn by 59.00. **Zero updates lost.**            |
| `naive_lost_update` | **500 of 500** | **+89.00**    | **489 debits vanished.** 489.00 created from nothing. |
| correct             | 100 of 500     | **0.00**      | 400 refused. The refusal is the feature.              |

The two bugs are **different bugs**, and that distinction is the point:
`naive_overdraft` writes `SET balance = balance - $1`, which PostgreSQL
re-evaluates against the updated row under READ COMMITTED — so its arithmetic
is exact and only the guard is missing. `naive_lost_update` computes the new
balance in JavaScript from a value that is already stale. One lets you go
negative; the other invents money.

```bash
docker compose up -d db && npm run db:migrate
npm test --workspace @daftar/api         # the race is deterministic, via a barrier
DAFTAR_NAIVE_LOST_UPDATE=true npm run dev:api   # then POST /v1/chaos/burst at it
```

### 2. Three correct strategies, and they trade off differently than I predicted

| Strategy       | Throughput     | p50     | p99          | Success   | SLO (p99 < 200 ms)    |
| -------------- | -------------- | ------- | ------------ | --------- | --------------------- |
| **`advisory`** | **1718 ord/s** | 18.2 ms | **125.7 ms** | 100%      | **PASS**              |
| `pessimistic`  | 1455 ord/s     | 18.4 ms | 222.0 ms     | 100%      | MISS, by 22 ms        |
| `serializable` | 878 ord/s      | 34.6 ms | 103.8 ms     | **74.5%** | fails on success rate |

Read `serializable` carefully: its p99 is the **best** in the table and it is
the worst strategy here, because a quarter of orders exhausted their retry
budget and returned a 5xx. A latency percentile computed over surviving
requests is a measurement of survivors.

`advisory` ships as the default.

### 3. The prediction I published and then disproved

**Predicted:** spreading load across 1,000 accounts instead of 1 would be the
dominant variable.

**Measured:** it changed almost nothing. The account spread was inert because
every order also touches a **house account**, and that was a single global hot
row — 2.5 M entries on each house account against 17 k on the busiest customer.
No amount of customer spread touches a row that every transaction touches.

Sharding the house accounts 16 ways restored **7–8.7× scaling**.

### 4. The load test found a different bottleneck than I predicted, again

Throughput is **flat at ~1,450 orders/s from 25 to 800 concurrent users** — a
32× increase in concurrency for no additional work. The cause was not the
connection pool, PostgreSQL, or memory:

| Resource              | At 200 users           | Headroom             |
| --------------------- | ---------------------- | -------------------- |
| **API container CPU** | **101.88%** = one core | **none — saturated** |
| PostgreSQL CPU        | 462%                   | 1,600% available     |
| API RSS               | 187 MB                 | 512 MB cap           |
| Event-loop p99        | 11.3 ms                | —                    |

**I predicted raising `DB_POOL_MAX` would help. It made things worse.**
Tripling it from 20 to 60 bought +3% throughput and cost +71% p99, moving the
SLO breach from 400 users down to 100 — because the pool was pinned at 20/20 as
a _symptom_ of the saturated core, and in that state it was doing useful work as
admission control.

I diagnosed from the metric that was easiest to see. `pool_waiting` peaked at
780 and genuinely moves first; the step I skipped was asking what the process
was doing while 780 requests waited. One `docker stats` would have shown 101%
CPU before any of the pool experiments. **"First resource to saturate" and "the
bottleneck" are different things.**

---

## Correctness is enforced by the database, not by the application

Every invariant below would survive someone writing to this database with
`psql`:

| Invariant                               | Enforced by                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| every transaction's legs sum to zero    | `DEFERRABLE INITIALLY DEFERRED` constraint trigger                                |
| at least two legs per transaction       | the same deferred trigger                                                         |
| `amount <> 0`                           | `CHECK`                                                                           |
| direction matches sign                  | `CHECK ((direction = 'debit') = (amount < 0))`                                    |
| entries are append-only                 | `REVOKE UPDATE/DELETE` + row triggers + a **statement-level** no-truncate trigger |
| no appending to a committed transaction | trigger                                                                           |
| an account's unit matches its entries   | composite foreign key `(account_id, unit)`                                        |
| one order per `external_id`             | `UNIQUE`                                                                          |
| one result per `Idempotency-Key`        | `UNIQUE`, arbitrated by the index rather than by a prior `SELECT`                 |

A row trigger does not fire on `TRUNCATE`, which is why the append-only
protection needs a statement-level one as well.

**Money is `bigint` in integer minor units, everywhere.** Never a float, never
a `number`. Amounts cross the wire as exact decimal strings because JSON has no
integer type wide enough — `JSON.parse` turns `"9007199254740993"` into
`9007199254740992`, silently. The realistic bug in TypeScript is not float
error, it is **string concatenation**: `pg` returns `int8` as a string by
default, so `balance + amount` yields `"100" + "50" = "10050"`. A type parser is
registered at boot and a runtime test asserts `typeof === 'bigint'` against
`9223372036854775807`.

**The ledger write path makes zero network calls.** Order prices are frozen into
the order from a database table at write time. That is what makes the amount
quoted the amount charged, and what makes every number here reproducible — an
order priced from a live feed would produce a different notional on every run,
so no before/after pair could be compared.

---

## Idempotency, on both surfaces

| Surface                       | Duplicate source                | Key chosen by | Measured                                              |
| ----------------------------- | ------------------------------- | ------------- | ----------------------------------------------------- |
| `POST /v1/orders`             | client or proxy retry           | the client    | 8 concurrent identical requests → **1 order**         |
| `POST /v1/webhooks/:provider` | provider at-least-once delivery | the provider  | 5 deliveries of one event → **1 funding transaction** |

Webhook signatures are HMAC-SHA256 over the **raw bytes**, verified before the
payload is parsed and before the replay window is checked — because until the
signature has vouched for it, the timestamp the window is checked against is
attacker-controlled. Verifying against a re-serialised body cannot work: a JSON
round trip changes number formatting, whitespace, unicode escaping, duplicate
keys and integer-like key order, and corrupts large integers outright.

---

## One query, indexed: 38× faster

The account statement with a running balance, against 12.8 M rows:

|                  | before                   | after        |                 |
| ---------------- | ------------------------ | ------------ | --------------- |
| execution (warm) | **161.451 ms**           | **4.208 ms** | **38× faster**  |
| plan             | Parallel Seq Scan + Sort | Index Scan   | Sort eliminated |

The migration that adds it,
[`0010_statement_index.sql`](apps/api/drizzle/0010_statement_index.sql), also
records **an index that was measured and then declined**, with the
write-amplification cost that made it not worth it. A list of indexes that all
helped is a list of indexes nobody measured.

`ORDER BY (created_at, id)`, never `created_at` alone: a four-leg order writes
every entry with one `now()`, so ties are guaranteed, and a window function's
frame is defined by its `ORDER BY`. Without the `id` tiebreaker two readers of
the same statement disagree about the intermediate balances. That is a
correctness bug, not a cosmetic one.

---

## Operations

**Observability.** One canonical JSON log line per request carrying
`duration_ms`, `db_ms`, `db_calls`, `retry_count`, `sqlstate`, `trace_id`.
Prometheus metrics that are **never labelled by account id** — unbounded
cardinality and a data leak. Eleven alert rules committed as code, one captured
firing end to end through Alertmanager to a delivered notification.

The memory alert is on the **six-hour slope of RSS**, not an absolute value,
and its runbook points at the tracing library: a library leaking a few megabytes
an hour never crosses a sensible ceiling until it suddenly does.

**Recovery, executed.** A base backup plus archived WAL restored to a chosen
instant, with the destructive transaction one second later **not** replayed.
PostgreSQL's log is the proof. RTO 1.8 s; RPO is `archive_timeout`, which is 300
s and not zero.

→ [`scripts/wal-restore-drill.sh`](scripts/wal-restore-drill.sh)

**Infrastructure.** Two topologies documented, memory caps published before the
load test measured against them, connection-pool arithmetic written out, and an
explicit list of what is **not** built.

---

## The beta exchange

Everything above measures one shape of order: a customer against the house, at a
price read from a table. The `beta-exchange` branch adds the other shape — a
live order book for one made-up coin, **DFT** — on the same ledger.

- **A real book.** Limit and market orders, price-time priority, partial fills.
  A fill is priced at the resting order's limit price. Market orders are
  immediate-or-cancel and never rest.
- **Twelve bots with unlimited balances** post and take orders at random levels
  around the mid, so the book has two sides at any hour. They are ordinary
  participants calling the same function as the HTTP endpoint; there is no
  generated price series. The price is whatever the last two participants
  agreed on.
- **Guests.** One click creates a funded account — 10,000.00, credited by a
  ledger transaction from a faucet account — and an HttpOnly session cookie.

Matching runs **in PostgreSQL**, one database transaction per incoming order,
under a row lock on the market. The order row, every trade it produced, every
resting order it consumed and four ledger entries per fill commit together. An
in-memory book would be far faster and would be a second copy of the state to
reconcile against the money; here there is one copy.

| Invariant                                      | Enforced by                               |
| ---------------------------------------------- | ----------------------------------------- |
| a market order never rests                     | `CHECK`                                   |
| `filled` means `filled_quantity = quantity`    | `CHECK`                                   |
| a limit order has a price; a market order none | `CHECK`                                   |
| the smallest possible fill is worth ≥ 0.01     | `CHECK (min_price * lot_size >= 1e8)`     |
| one trade, one ledger transaction              | `UNIQUE (transaction_id)` + foreign key   |
| one order per client id, per participant       | `UNIQUE`                                  |
| a guest cannot go negative                     | the ledger's non-negative check, per fill |

"Unlimited balance" has a precise meaning in a ledger that sums to zero: a bot's
accounts are allowed to go negative, the way the house's are. Every coin a guest
holds is a coin some bot is short.

### What the exchange uses from the rest of this repository

The order book started out using only the ledger. It now uses the parts that
were built for the house path as well:

| Feature                   | On the exchange                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Idempotency-Key`         | A retried order gets the original answer back — same order, same fills — instead of a 409. For an accepted order the response is recorded **inside the matching transaction**.             |
| Webhooks                  | A deposit is a signed event from a simulated provider, delivered to the real `POST /v1/webhooks/simbank`. Ask for it to be delivered five times at once and it is credited once.           |
| Outbox                    | Every guest fill, deposit, withdrawal and transfer commits an outbox row with the money. A worker publishes them to a per-guest activity feed, which can be late but cannot miss an event. |
| Account locks, under load | Withdrawals and guest-to-guest transfers do **not** take the market lock, so they overlap fills on the same cash account. The ledger's sorted account locks are what keep them honest.     |

Two things are deliberately still not used. The three concurrency strategies are
not selectable on the exchange: everything there is `advisory`. And the naive
paths have no exchange equivalent — they remain reachable through the legacy
API and the test suite.

Cash reserved by an open buy order cannot be withdrawn or sent, but that check
reads the reservation without the market lock. The backstop is the ledger: a
balance never goes negative, and a resting order that can no longer be covered
is withdrawn by the matcher when it would have filled.

**A bug the first live run found.** The bots rounded both bids and offers _down_
to the tick. Flooring a bid moves it away from the mid; flooring an offer moves
it toward the mid — so every pair of quotes sat half a tick low, the next mid
was computed from them, and the price fell 13% in half an hour in a straight
line while the mean reversion pushed the other way and lost. Bids now round down
and offers round up. Over the next 6,900 trades the price stayed between 24.91
and 25.33 with a 50.0% buy/sell split.

**What this is not.** No fees, no margin, one market, no real payment provider
(deposits come from a simulated one and payouts go to a simulated rail), and
the reservations of open orders are still arithmetic over those orders rather
than money moved into a hold account — only withdrawals use a hold account.
Live updates are pushed over server-sent events when the event log is running,
and the screen falls back to polling when it is not; there is no WebSocket.
The event log is **one Apache Kafka node with replication factor 1**: losing
its disk loses the log, which can be rebuilt from PostgreSQL, and nothing else.
It acknowledges writes from the page cache (Kafka's default), so a host crash
can lose the last few seconds of events — feed rows, position updates and
notifications, never money.
Delivery is at-least-once everywhere and every consumer is idempotent by a
PostgreSQL unique key; **no exactly-once is claimed**, because Kafka's
exactly-once ends at the broker and the effects here are in PostgreSQL. Missed
recurring-buy runs are not made up. The legacy API is still unauthenticated
and still mounted; it must not be exposed on a public deployment of this
branch as it stands.

### The event log and the job queue

The PostgreSQL outbox is still where every event is born, in the same
transaction as the money. The outbox worker is now a **relay**: it produces
each claimed batch to Kafka (keyed by account, idempotent producer) and
marks the rows published only after the broker acknowledged them. With the
broker down, orders keep committing and the outbox backs up; it drains in
order when the broker returns. Matching never touches Kafka or BullMQ.

| Consumer / job      | What it does                                                                    | Idempotent by                                       |
| ------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| activity            | the per-guest feed                                                              | `UNIQUE (outbox_event_id)` + `consumer_receipts`    |
| positions           | average entry, realised P&L; rebuildable with `projections:replay`              | `consumer_receipts`                                 |
| reconciler          | compares positions and withdrawal holds with the ledger, records time-to-detect | `consumer_receipts`                                 |
| withdrawals         | turns withdrawal events into `rail.submit` jobs                                 | job id `<eventId>-submit` + state compare-and-set   |
| notifier → `notify` | in-app notifications                                                            | `UNIQUE (event_id, kind)`                           |
| `dca.fire`          | one Job Scheduler per recurring buy                                             | idempotency key + `UNIQUE (plan_id, scheduled_for)` |

**Withdrawals are a saga.** The request moves the cash into a per-guest hold
account; the payout rail is called from a BullMQ job; the hold is settled to
the outside world on confirmation or released back on failure. A database
trigger enforces the legal state transitions and writes their history, and a
settlement or release can exist at most once per withdrawal.

### Why Kafka and Valkey, when PostgreSQL can queue

PostgreSQL already queues here — the outbox is a queue, and it stays the
source of truth. BullMQ v6 also ships an official PostgreSQL backend, so
"BullMQ, but on the database we already run" was a real option. It was not
taken, for three reasons that are about this repository specifically:

- **The database is the measured bottleneck's neighbour.** Every number above
  is about contention on PostgreSQL; delayed jobs, rate limiters and stalled-job
  checks polling the same database would add load to the one component the
  benchmarks are about. Valkey takes that load elsewhere.
- **Maturity.** BullMQ's own documentation calls the Redis backend the most
  battle-tested; the PostgreSQL backend had open parity bugs at the time of
  writing (e.g. missed events, `removeOnComplete: 0` deleting all finished jobs).
- **Replay is a different job from queueing.** A queue deletes what it has
  delivered. A projection that must be rebuildable from the beginning needs a
  log that keeps everything and lets each reader keep its own position. That
  is what Kafka is for here; the outbox reaps its rows after a day.

**Kafka, not Redpanda.** The event log started on Redpanda. The code only ever
spoke the Kafka protocol, so swapping brokers did not change the application.
Two things drove the swap. Redpanda's production guidance is 2 GB of RAM per
core. Its 26.2 line, the last under BSL 1.1, reaches end of support on
2027-07-28, and after that only Community Edition terms remain. Kafka is
Apache 2.0 and runs here in a 1 GB cap. It gives up one thing: Redpanda
fsyncs before it acks, and Kafka by default acks from the page cache.

The cost is two more stateful services and about 1.5 GB of memory caps. Neither is trusted for
correctness: every guarantee is a PostgreSQL constraint, and PostgreSQL-side
sweepers re-drive anything a lost job or message would have done.

**Measured** (local dev box, not the 8 GB target).
These runs were made **on Redpanda v26.2.7**, before the swap to Kafka, and
have not been repeated on Kafka:

| Claim                                              | Result                                                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Broker stopped for 30 s under load                 | 284 orders filled during the outage; 993/993 events delivered, 0 lost, 0 dead-lettered; backlog cleared ≤ 1 s after restart |
| Positions rebuilt from offset 0                    | 2,202 messages in 11.6 s; matches the ledger except the one guest whose fills predate the outbox                            |
| Projection drift injected                          | 5/5 detected in ~14.5 s (full-sweep path, 2 s interval)                                                                     |
| 60 withdrawals, rail timing out/dropping/rejecting | 54 paid once each, 6 returned, 0 holds left, funding moved by exactly what was paid                                         |
| Push vs 2 s polling                                | p50 667 ms vs 2,293 ms; 4,192 vs 9,600 requests/min for 50 viewers                                                          |
| Recurring buy, 41 min                              | 41 ticks → 41 runs → 41 orders; a tick during a worker outage ran late, once                                                |

Three of those runs found bugs, fixed before the numbers above were taken: the
outbox backlog waited out its outage backoff after the broker was back; a
scheduler tick's time was read from the wrong field, which could have
deduplicated a real run away; and Redpanda's image (the broker then) ships in
developer mode, which bypasses fsync even when `--mode dev-container` is not
used.

```bash
npm run exchange:db:create      # a separate database: never the seeded one
npm run exchange:db:migrate
npm run broker:up               # Kafka + Valkey
npm run kafka:topics            # creates the topics; the broker never auto-creates them
npm run dev:exchange            # API on :3000 with the bots trading and live push on
npm run dev:workers             # relay, consumers, BullMQ workers, market ticker
npm run dev:web                 # :5173
```

On an exchange database that already has history, run `npm run kafka:backfill`
once, with the workers stopped, before the first `dev:workers`: it puts every
event already in the feed onto the log with its original id, so a replay covers
everything. It reports guest fills from before the outbox existed, which no
event describes and the positions projection therefore cannot include.

The bots, the outbox relay and every worker are **off by default** and the
exchange gets its own database, for one reason: they write around the clock,
and the seeded database is the dataset every number above was measured
against.

---

## The UI

Three pages. **Trade** is the live market: chart, order book, latest trades and
an order ticket that says in a sentence what the order will do before it is
sent. **Portfolio** is the guest's account: what it is worth, what was put in and
the profit or loss between them, each shown as a sum that adds up on screen, a
cash panel (deposit, withdraw, send to another guest by handle) and the latest
activity. **History** has every activity row, trade and order, and each opens a
receipt with the balanced ledger lines behind it.

Profit and loss is measured against what the guest has put in, net — read from
the ledger — rather than against the fixed opening balance, so a deposit is not
mistaken for a gain.

A permanent band says it is play money. In development, `/dev/states` reaches
every screen in every state against an in-memory mock (`?mock` switches to it);
neither the mock nor that page is in a production build.

The original seven "Ledger lab" pages have been removed from the interface. The
API behind them — the legacy order path, the naive debit paths, the chaos burst
endpoint, the statement and transaction reports — is unchanged and still
exercised by the test suite and the load scripts.

---

## Run it

```bash
docker compose up -d db
npm ci
npm run db:migrate
npm run seed -- --entries 10000000 --customers 2000   # ~10 min
npm run dev:api        # :3000, OpenAPI at /docs
npm run dev:web        # :5173
```

Optional:

```bash
docker compose -f compose.observability.yaml up -d    # Prometheus, Alertmanager, Jaeger
bash scripts/wal-restore-drill.sh                     # the recovery drill, self-contained
.tools/bin/k6 run load/ramp-to-break.js               # the break-point test
```

---

## Stack, and where it deviates

Node 26 (native TypeScript type-stripping, no transpiler), Fastify 5, Zod 4,
Drizzle, **PostgreSQL 18**, React 19 + Vite, React Router, TanStack Query, Radix, Tailwind 4,
Vitest.

**PostgreSQL 18 specifically**, for `DEFERRABLE INITIALLY DEFERRED` constraint
triggers, `xid8`, and `io_method=worker`. Also one trap worth repeating: the
PG18 image stores data in a major-version subdirectory, so a volume must mount
at `/var/lib/postgresql` and **not** `/var/lib/postgresql/data` — the old path
makes the container refuse to start.

Deviations from my usual defaults, and why:

- **REST + OpenAPI instead of tRPC.** A published, versioned HTTP contract is
  part of what a brokerage API _is_, and a committed Postman collection and
  `/docs` are deliverables. tRPC's advantage is zero codegen inside a monorepo,
  which is not the constraint here.
- **Tests run against real PostgreSQL in Docker, never PGlite.** PGlite compiles
  PostgreSQL to WASM and runs it single-user, holding an exclusive mutex per
  transaction — so two transactions are never in flight at once, and it
  _silently passes_ every check-then-write bug this repo exists to demonstrate.
  A test substrate that cannot fail is worse than no test.
- **Tracing is off by default, including in production.** The OpenTelemetry SDK
  is the component most likely to leak memory here, and a ledger that stops
  accepting orders because the thing watching it exhausted the box is the worse
  outcome. `auto-instrumentations-node` is specifically not installed, and a
  test fails CI if `instrumentation-fs` reappears.
- **No authentication on the legacy API.** (The exchange has guest sessions; see
  above.) A deliberate scope decision: the subject is a correct
  ledger under concurrency, and a login would add a password-hashing capacity
  constraint without making the ledger any more or less correct. The interface
  no longer calls the legacy API at all; it remains for the benchmarks and
  tests, and must not be exposed publicly as it stands.

---

## What breaks first at 100×

At 145,000 orders/s, in order:

1. **One API core**, immediately. Needs ~100 instances. The easy part — the
   write path is stateless.
2. **The 16 house shards**, almost as immediately. `pg_stat_activity` already
   shows `Lock/advisory` as the dominant wait, with 19.6 backends blocked
   against 2.8 running. Each shard would need to serialise ~9,000
   transactions/s while holding a lock across a WAL flush. Raising
   `HOUSE_SHARDS` is the first real fix — **and it is unverified**, because
   testing it needs a migration and a re-seed, and quoting a number for it
   would be exactly the extrapolation the rest of this repo argues against.
3. **`LWLock/WALWrite`** — already the second-largest wait. One primary has one
   WAL stream, so this is the first limit that sharding the application cannot
   route around.
4. **`max_connections`** — where PgBouncer stops being unnecessary, and where
   transaction-scoped advisory locks turn out to have been the right choice.

**Note the shape of that list.** Phase 3 found the house accounts were a global
hot row and sharded them 16 ways. Phase 10 found that 16 shards is now the
ceiling. The same bug, one level up, because the constant was chosen for the
load at the time and never revisited.

---

## What I would do differently

- **Check utilisation before queueing.** The pool mistake cost two full
  benchmark runs and would have been avoided by one `docker stats`.
- **Make the shard count configurable from the start.** `HOUSE_SHARDS = 16` is
  a hardcoded constant, so the fix for the current bottleneck needs a migration.
  It should have been a tunable with the number recorded with each run.
- **Build the chaos burst endpoint earlier.** It is the fastest way to reproduce
  a concurrency bug by hand, and it existed only after most of them were already
  found the slow way.
- **Measure backup throughput on representative storage.** The 57-second base
  backup for 35 MB is a btrfs artefact, and I reported it without characterising
  it — which leaves a reader unable to predict the real one.
- **Ship metrics off-box from the start.** The observability stack does not fit
  on the 4 GB target alongside the application, which was discovered when the
  budget was written rather than when the stack was chosen.

---

MIT. See [`NOTICE`](NOTICE) for third-party attribution.

**This is a demo. No real funds, no real trading, no real bank.**
