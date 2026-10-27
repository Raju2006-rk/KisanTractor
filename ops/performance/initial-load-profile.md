# Initial load profile and performance results (task 15.3)

This document defines the load that Requirement 18.4 budgets apply to. It also records what the load suite measured, what was tuned, and which budgets are met. The numbers live in `apps/api/src/performance/load-profile.ts`; change them there, then update this page.

## The profile

Every number is a **planning assumption for the Phase 1 launch**, not measured demand. Nothing has launched, so no field data exists yet. Once real traffic exists, replace these numbers with the `kt_http_server_*` metrics (see `ops/observability`).

### Data volume (end of the first 180-day season)

| Item | Volume | Basis |
| --- | --- | --- |
| Launch districts | 12 (6 Telangana, 3 Andhra Pradesh, 3 Karnataka) | Pilot footprint around the Telugu-first launch locale |
| Owners | 1,500 | About 125 per district |
| Tractors | 4,000 | 20 fleet Owners with 25 Tractors each. Every other Owner has 1–4. Tractors sit within 30 km of their district headquarters. |
| Offerings / prices | 9,672 offerings, 19,344 pricing rules | Every Tractor offers ploughing plus 0–4 more services. Each offering has an hourly price and a per-acre or per-trip price. |
| Farmers | 20,000 | About 5 Farmers per Tractor |
| Historical bookings | 120,000 (about 650 a day) | One booking per Tractor every 6 days over the season. 75% completed and paid in cash; 10% rejected, 10% expired, 5% cancelled. 15% were booked for someone else. |
| Booking rows | 691,230 status-history rows, 179,852 work events, 89,926 invoices and cash payments | Derived from the bookings above |
| Identity rows | 64,260 consumed OTP challenges, 21,420 sessions | About three sign-ins per background account over the season |

Active principals sign in through the OTP sandbox and drive the HTTP load. Their seeded history puts them at the heavy end of the distribution:

- 5 fleet Owners with 25 Tractors and 3,050–3,175 bookings each (up to 159 dashboard pages of 20).
- 15 Owners with 4 Tractors and 200 bookings each.
- 60 Farmers. 4 of them have about 400 bookings each; the other 56 have about 40.

Not seeded: historical outbox, audit, notification, document, and idempotency rows. The read paths under test do not touch them. The write paths only append to them, and idempotency records start empty, as they will on launch day.

### Traffic

Peak-season morning hour:

- **Farmers:** 3,000 active a day (15% of 20,000). 20% of them use the app in the peak hour, about 12 requests each, which is about 2 requests per second (req/s).
- **Owners:** 900 active a day (60% of 1,500). 25% of them use the app in the peak hour. A dashboard visit fans out to one availability read per Tractor, so each makes about 30 requests, which is about 1.9 req/s.

That gives about 4 req/s on average across the peak hour. Allowing a 5× burst inside the peak minute gives the **design point: 20 req/s, open loop, for 120 s**. The latency budgets are asserted at this rate. A **headroom step at 40 req/s** is also run and reported; only the "no 5xx" rule is asserted for it.

Request mix: 80% reads and 20% writes. Discovery counts as a read even though it is a POST, because it changes no state.

| Reads | Share | Writes | Share |
| --- | ---: | --- | ---: |
| `discovery.search` | 25% | `farmer.booking.create` | 8% |
| `farmer.bookings.list` | 8% | `owner.booking.accept` | 4% |
| `farmer.bookings.deepPage` (random page of a 400-booking history) | 4% | `owner.booking.reject` | 1% |
| `farmer.booking.detail` | 8% | `owner.job.start` | 2% |
| `farmer.booking.settlement` | 3% | `owner.job.complete` | 2% |
| `owner.bookings.list` | 8% | `owner.payment.cash` | 2% |
| `owner.bookings.deepPage` (random page of a 3,175-booking dashboard) | 6% | `identity.otp.request` (new sign-up) | 0.5% |
| `owner.booking.detail` | 6% | `identity.otp.verify` | 0.5% |
| `owner.tractors.list` | 4% | | |
| `owner.tractor.availability` | 4% | | |
| `owner.job.session` | 2% | | |
| `identity.session` | 2% | | |

Discovery radius: 50% use the 5 km default, 30% use 25 km, 15% use 50 km, and 5% use 100 km. 30% of searches filter by pricing method. Search origins are random points within 20 km of a district headquarters.

A job-pipeline write runs only when there is work for it: a pending request to accept, an accepted job to start, a started job to complete, or a final bill to pay. If its queue is empty, the slot becomes a booking request instead. This happened 10 times in a 2,415-request design step.

### Concurrent acceptance race

40 fleet Tractors each have 4 pending requests that all overlap 12:00–12:30, plus 1 adjacent request ([15:00, 17:00) touches [12:00, 15:00) without overlapping it).

- For each Tractor, all 5 acceptances are sent at the same instant, in shuffled order.
- 30 Tractors start their races 250 ms apart, on top of the design load.
- The last 10 Tractors all start together as a stress case. Correctness is asserted for this case; latency is reported but not budgeted.

Expected outcome: exactly one overlapping request and the adjacent request accepted per Tractor, with no 5xx responses.

## Budgets

Requirement 18.4 applies at the design point: p95 read latency below 500 ms and p95 state-changing latency below 800 ms, excluding asynchronous provider completion. Latency is measured by the client from each request's **scheduled** start, so a slow server cannot hide queueing (no coordinated omission). It includes reading the full response body. The server-side `kt_http_server_request_duration_ms` histogram is also captured for every step.

## How it runs

- `apps/api/src/performance/load.performance.test.ts` is gated by `LOAD_TEST_DATABASE_URL`. That must be a local database whose name contains `test`; the suite migrates and truncates it.
- `load-api-server.ts` runs the composed Nest API in a child Node process (`tsx`, as `pnpm dev` does) with production request telemetry and the default pg pool (`createSqlPool`, 10 connections). The load generator therefore does not share the API's event loop.
- `load-seed.ts` plans the dataset from a fixed PRNG seed and bulk-loads it with `INSERT … SELECT FROM unnest(…)` in about 110 s.
- `load-runner.ts` holds the open-loop scheduler and nearest-rank percentiles. Its unit and property tests run with the default `vitest run`.

```powershell
docker exec kisan-e2e-pg psql -U kisantractor -d postgres -c "CREATE DATABASE kisantractor_load_test"
$env:LOAD_TEST_DATABASE_URL = "postgresql://kisantractor:kisantractor@127.0.0.1:55432/kisantractor_load_test"
$env:LOAD_TEST_RESULTS_PATH = "$env:TEMP\kt-load.json"      # optional JSON report
$env:LOAD_TEST_BROWSER = "1"                                 # optional: responsive screen audit (needs apps/web build)
$env:LOAD_TEST_STEP_SECONDS = "20"                           # optional: shorter steps for a quick pass
corepack pnpm test:load
```

`LOAD_TEST_API_POOL_MAX` overrides the API's pool size, for tuning comparisons only. A full run takes about 7 minutes; the browser audit adds about 6.

### Test environment (all numbers below come from it)

- Host: Windows laptop, Intel i5-1235U (12 threads), 15.7 GB RAM, Node 24.14.1. The load generator and the API run on this host as separate processes.
- Database: `postgis/postgis:17-3.5-alpine` in Docker Desktop with stock settings (128 MB shared_buffers, 100 max connections).
- The API's pg pool: the default of 10 connections.

This is development hardware, not production. Treat the numbers as evidence of query shape and headroom, and re-run the suite on staging hardware before launch.

## Results

### Mixed load: before and after tuning

All latencies are client-side, in ms.

| Step | Requests | Reads p50 / p95 / p99 | Writes p50 / p95 / p99 | 5xx | Unexpected statuses |
| --- | ---: | --- | --- | ---: | ---: |
| Design 20 req/s, **before** | 2,415 | 39.4 / **239** / 557 | 57.7 / **94.3** / 112 | 0 | 0 |
| Design 20 req/s, **after** | 2,415 | 27.8 / **56.9** / 99.2 | 45.5 / **85.3** / 115 | 0 | 0 |
| Headroom 40 req/s, **before** | 4,779 | 51.7 / 530 / 907 | 73.5 / 184 / 589 | **1** (booking create) | 1 |
| Headroom 40 req/s, **after** | 4,784 | 32.1 / 73.5 / 169 | 54.6 / 101 / 231 | 0 | 0 |

Discovery was the slowest operation. Before tuning it measured p95 428 ms, p99 857 ms, and max 1,019 ms at the design load, and p95 773 ms at the headroom step. After tuning it measured p95 55 ms and p99 96 ms at the design load, and p95 74 ms at the headroom step.

After tuning, at the design load, every route's server-side p95 falls in the ≤ 100 ms histogram bucket or lower. Accepted bookings, rejections, job actions, and cash records all returned only 201 or a genuine 409 `OVERLAP`. No 409 came from contention, meaning a valid action refused only because another transaction ran at the same moment.

<details><summary>Design-load operations after tuning (p50 / p95 / p99 ms)</summary>

| Operation | Count | p50 | p95 | p99 | Statuses |
| --- | ---: | ---: | ---: | ---: | --- |
| discovery.search | 594 | 25.8 | 54.8 | 96.4 | 201×594 |
| farmer.bookings.list | 178 | 34.5 | 66.2 | 183.4 | 200×178 |
| farmer.bookings.deepPage | 87 | 36.2 | 62.7 | 132.4 | 200×87 |
| farmer.booking.detail | 187 | 26.7 | 57.6 | 92.5 | 200×187 |
| farmer.booking.settlement | 80 | 21.5 | 39.1 | 125.2 | 200×80 |
| owner.bookings.list | 200 | 37.0 | 65.3 | 111.3 | 200×200 |
| owner.bookings.deepPage | 134 | 39.2 | 86.0 | 134.5 | 200×134 |
| owner.booking.detail | 155 | 25.4 | 40.8 | 62.6 | 200×155 |
| owner.tractors.list | 99 | 18.2 | 39.4 | 53.2 | 200×99 |
| owner.tractor.availability | 103 | 19.9 | 34.1 | 48.1 | 200×103 |
| owner.job.session | 49 | 24.4 | 46.2 | 64.6 | 200×49 |
| identity.session | 60 | 13.5 | 24.8 | 56.6 | 200×60 |
| farmer.booking.create | 211 | 47.8 | 88.1 | 149.0 | 201×211 |
| owner.booking.accept | 102 | 38.7 | 72.4 | 89.6 | 201×88, 409 OVERLAP×14 |
| owner.booking.reject | 19 | 37.7 | 64.9 | 64.9 | 201×19 |
| owner.job.start | 49 | 40.7 | 66.0 | 76.7 | 201×49 |
| owner.job.complete | 38 | 59.2 | 113.6 | 115.2 | 201×38 |
| owner.payment.cash | 54 | 48.3 | 88.3 | 97.8 | 201×54 |
| identity.otp.request / verify | 8 / 8 | 20.9 / 30.1 | 48.2 / 85.1 | — | 201×8 / 200×8 |

</details>

### Concurrent acceptance

| Case | Before tuning | After tuning |
| --- | --- | --- |
| Staggered, 30 Tractors × 5 simultaneous acceptances | 31 accepted, **119 × 409 `CONCURRENT_RESERVATION`**. Adjacent requests were refused; p95 81 ms. | **60 accepted (1 overlapping + 1 adjacent per Tractor)**, 90 × 409 `OVERLAP`; p95 117 ms, p99 127 ms |
| Stress, 10 Tractors × 5 at the same instant | 11 accepted, 37 × `CONCURRENT_RESERVATION`, 2 × `OVERLAP`; p95 268 ms | **20 accepted**, 30 × `OVERLAP`; p95 583 ms |

Double booking was never possible: the exclusion constraint rules it out, and after tuning a SQL check finds zero overlapping blocking bookings. The defect before tuning was that SERIALIZABLE aborts refused valid acceptances, including requests that did not overlap.

### Indexed discovery (EXPLAIN ANALYZE at launch volume, Warangal origin)

| Radius | Before | After | Plan after |
| --- | ---: | ---: | --- |
| 5 km | 2.5 ms | 1.4 ms | `locations_coordinates_gist_idx`, then `tractors_current_location_idx`, then offering, pricing, and blocking-interval indexes. No sequential scans. |
| 25 km | 220 ms | 11.6 ms | same |
| 100 km | 943 ms | 32.9 ms | same |

Before tuning, every radius re-scanned the whole Tractor table once per spatial candidate: 356 × 3,156 rows at 25 km. The cause is that PostGIS estimates the geography `ST_DWithin` filter at one row regardless of radius, which led the planner into a nested loop with a sequential inner scan.

### Booking, dashboard, payment, and job reads

| Query | Before | After |
| --- | --- | --- |
| Owner bookings page, first and deep (`LIMIT 21`) | 45 ms / 41 ms; sequential scan of `booking_recipients` (18,294 rows) | 0.83 ms / 0.82 ms on `bookings_owner_history_cursor_idx` and `booking_recipients_booking_idx` |
| Farmer bookings page (`LIMIT 51`) | 16.7 ms; sequential scans of 4 tables | 1.38 ms |
| Booking detail (booking, payments, history) | 1.4 ms with a `booking_recipients` scan | 0.49 ms; payments and history on their cursor indexes with `LIMIT` |
| Settlement (`/payments`) | 0.3 ms | 0.5 ms; index scans only |
| Owner Tractor list (`LIMIT 100`) | 0.37 ms with a full `tractors` scan | 0.21 ms on `tractors_owner_inventory_idx` |
| Job session | 0.2 ms | 0.2 ms; index scans only |

Planning, not execution, now dominates the booking list: 13–18 ms to plan the 9-way join, against under 1.5 ms to execute it. That is well within budget, so no change was made. Prepared statements would remove most of it if needed later.

### Cursor pagination over HTTP

The suite walks the whole history with `nextCursor` and compares it with SQL `ORDER BY created_at DESC, id DESC`.

| History | Limit | Pages | Before | After |
| --- | ---: | ---: | --- | --- |
| Fleet Owner A, 3,175 bookings | 20 / 50 | 159 / 64 | complete | complete; page p95 32.7 / 52.3 ms |
| Fleet Owner B, 3,125 bookings | 20 | 157 | **4 bookings missing** | complete; p95 36.4 ms (40.8 ms at limit 50) |
| Heavy Farmer, 401 bookings | 20 / 50 | 21 / 9 | complete | complete; p95 27.2 / 49.6 ms |

The cost per page stays flat. The median of the last 10 pages was 22–43 ms, against 24–34 ms for the first 10; the suite asserts it stays under the larger of 2× the first-10 median and that median plus 15 ms. `limit=0` and `limit=51` return 422, and a discovery `pageSize` of 51 returns 422.

The 4 missing bookings were 6 bookings committed within the same millisecond. That happens when requests are concurrent, and the seed includes one such burst per fleet Owner. The cursor carried a JavaScript `Date`, which keeps milliseconds, while PostgreSQL stores microseconds. Every booking in the same millisecond as a page's last row, but earlier in microseconds, was skipped.

## Tuning applied

Each change is minimal, and each was confirmed by the before/after measurements above.

1. **Migration `0015_load_profile_indexes`** adds three indexes and changes nothing else:
   - `tractors (current_location_id)`, so discovery reaches Tractors from their spatial candidates.
   - `booking_recipients (booking_id)`, for every booking list and detail read.
   - `tractors (owner_id, created_at DESC, id DESC)`, for the Owner dashboard's Tractor list.
2. **Discovery query** (`postgres-discovery-store.ts`): the Tractor and availability join is now a `LATERAL (… OFFSET 0)` lookup per spatial candidate. The `OFFSET 0` stops the planner flattening the subquery and choosing a plan from the one-row PostGIS estimate. Filters, ordering, and keyset pagination are unchanged, and the 7.4 integration suite still passes.
3. **Booking cursors** carry `created_at` with microseconds, from `to_char(… 'US')`. Cursors issued in the old millisecond format still decode.
4. **Bounded serialization retry** (`serialization-retry.ts`). Booking create and transition, job actions, and cash payments now retry SERIALIZABLE aborts (40001/40P01, and 23P01 for acceptance) up to 4 times with jitter. Each retry is a fresh transaction, so it re-reads the idempotency claim and the winner's committed state: an overlapping acceptance then fails with `OVERLAP`, and an adjacent one succeeds. If the retries run out, the response is the existing 409 conflict. Booking creation previously returned a 500 here and now returns a 409 `CONCURRENT_RESERVATION`. The identity store already used this policy.
5. **Pool size: no change.** At the design load at most 6 requests were in flight, and every route's server-side p95 is ≤ 100 ms with the default 10-connection pool.

## Budget status

| Budget | Status |
| --- | --- |
| Requirement 18.4 p95 read < 500 ms at the design load | **Met:** 56.9 ms (239 ms before tuning) |
| Requirement 18.4 p95 write < 800 ms at the design load | **Met:** 85.3 ms |
| Requirement 18.3 cursor pagination and bounded queries | **Met:** every list uses keyset cursors, `LIMIT` is enforced, and page cost is flat. The skipped-row defect is fixed. |
| Concurrent acceptance: one winner per interval, no 5xx, within budget | **Met:** p95 117 ms staggered. The 10-Tractor simultaneous stress case is correct, with p95 583 ms. |
| Requirement 17.1 responsive Farmer and Owner screens | **Met:** see the next section |
| Requirement 16.6 landing web vitals | **LCP and CLS met; the TBT part of the INP proxy is not.** See [Web vitals](#web-vitals-requirement-166). |

### Open finding: simultaneous first-time registrations

Twenty OTP verifications sent at the same instant fail closed: 8–9 of 20 return 401 and no session is created, and the others take about 600 ms. This is consistent with the identity store exhausting its 6 SERIALIZABLE retries. At the profile's sign-up rate (0.1/s) all 16 measured sign-ups succeeded, so this lies outside the documented load. Before a launch campaign that could create sign-up bursts, it needs a follow-up: find which index ranges the verify transaction conflicts on, or move first-time registration off SERIALIZABLE.

## Responsive Farmer and Owner screens (Requirement 17.1)

Enabled with `LOAD_TEST_BROWSER=1`. The audit opened 8 screens against the seeded data at each device profile in `apps/web/quality/profiles.ts` (low-end mobile, narrow mobile, tablet, laptop, desktop, and desktop at 200% zoom), using the existing DevTools driver with headless Chrome 155. That is 48 page loads.

- Farmer screens: home, search (25 km, live results), bookings history, and a completed booking with its invoice and payment.
- Owner screens: the fleet dashboard (25 Tractors), the bookings history, a booking detail, and the Tractor list.

**Result: 48 of 48 have zero horizontal overflow and no element extends past the viewport.** None of these screens render an `<img>`. Each transfers about 188 KB of JavaScript; CSS is now inlined. The first audit run flagged a false failure on the laptop profile's search page (1,351 vs 1,366 px): `clientWidth` excludes the scrollbar. The audit now compares `innerWidth` with the profile and checks overflow against `clientWidth`.

## Web vitals (Requirement 16.6)

The lab runs `corepack pnpm --filter @kisantractor/web test:landing` with `KT_LAB_RUNS=5`, on the low-end-mobile profile: 4× CPU slowdown on slow 4G. The table shows p75 of the cold loads.

| Build | LCP | CLS | TBT | Lab interaction | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Task 14.3 record | 2,640 | 0 | 916 | — | as reported then |
| Today, before tuning | **2,728** | 0 | 608 | 24 | HTML 7,115 B, JS 144,849 B, external CSS 6,772 B (gzip) |
| `experimental.inlineCss` | **2,108** | 0 | 551 | 32 | kept |
| inlineCss + webpack bundler | 1,984 | 0 | 539 | 40 | TBT unchanged; **not kept** |
| inlineCss + trimmed font fallback list | 2,020 | 0 | 765 | 64 | no measurable gain; **reverted** |
| **Final: full landing suite, 43 checks** | **2,140** | **0** | **886** | **72** | 42/43 pass; HTML 27,251 B gzip, within the 30,000 B budget |

- **LCP ≤ 2.5 s: met** (2,108–2,140 ms p75). The LCP element is the hero `<h1>`, so LCP equals first paint. Inlining the 6.8 KB-gzip stylesheet removes the render-blocking CSS request, which costs 562 ms of added latency on this profile. The cost is that the CSS is no longer cached separately across navigations; HTML grows from 7.1 to 27.3 KB gzip because Next also embeds the CSS in the RSC payload.
- **CLS ≤ 0.1: met** (0).
- **INP ≤ 200 ms: half met.** The lab tap's event duration is p75 72 ms, within budget. The Total Blocking Time half of the proxy is p75 551–886 ms against 200 ms, with high run-to-run spread (356–928 ms).

#### What blocks TBT

Long-animation-frame attribution shows one main-thread task of 450–900 ms. It is the React/Next runtime chunk evaluating and hydrating; a CPU profile puts about 480 ms of self time in Turbopack's module runtime alone. A near-empty page (`/privacy`) under the same shell measures the same 728–862 ms TBT. The cost is therefore the framework's startup, not landing content.

Changing the bundler or the font stack did not move it. Meeting 200 ms would mean not hydrating React on `/` at all: a static, script-free landing, with the web-vitals beacon replaced by a small inline observer. That is an architecture decision beyond tuning, so it is left for a decision rather than done here. The budget was not relaxed.

DevTools CPU throttling scales this host's speed, as `apps/web/quality/README.md` notes. Confirm on CI hardware of known speed, and in the field through `kt_web_vital_*`, before treating these lab numbers as final.

## Known flaky checks seen while re-running the existing suites

These are in code this task did not change.

- **`phase1-vertical-slice.e2e.test.ts`, late pause after completion.** The test sometimes expects `validNextActions: []` and receives `["RESUME"]`. The late pause gets the same domain-clock timestamp as `COMPLETE`, and the job store then orders the candidate event against `COMPLETE` by comparing `candidate:<key>` with a random UUID. The 409 itself is always correct. It failed in 3 of 9 runs.
- **`security.e2e.test.ts`, tampered discovery cursor.** It returned 201 instead of 422 once in 7 runs. Cursor signing was not touched.
