# RelayAPI Rate Limiter

This repository contains the prototype for the RelayAPI distributed rate limiter.

It provides strict, per-customer fixed-window rate limiting backed by Redis. This service exists to demonstrate a robust architecture capable of enforcing arbitrary RPM limits fairly and accurately across a cluster of stateless application nodes, without compromising auditability or resorting to hidden code bypasses.

## 1. Architecture

```text
         Client
           │
           ▼
         nginx
           │
     ┌─────┼─────┐
     ▼     ▼     ▼
  Node 1 Node 2 Node 3
     │     │     │
     └─────┼─────┘
           ▼
         Redis
```

- **Application nodes are stateless.** They hold no rate-limit memory or counters locally.
- **Redis contains shared rate-limit state.**
- **nginx distributes requests** across the application nodes in a round-robin fashion.
- **All nodes use the same Redis-backed limiter**, ensuring global quota enforcement.

## 2. Rate-Limiting Semantics

A customer's configured quota is the maximum number of accepted requests in one aligned UTC calendar-minute window.

- **Window Resolution:** `window_id = floor(unix_seconds / 60)`
- **Key Format:** `customer + window → Redis key` (e.g., `rl:northwind:29803013`)

- **Accepted requests** increment the counter.
- **Rejected requests do not increment** the accepted-request counter.
- **The decision is made atomically** inside a Redis Lua script.
- When the quota is reached, subsequent requests within that window receive a `429 Too Many Requests` response.
- A new UTC calendar minute automatically creates a new window with a fresh quota.

## 3. Why Fixed Window?

The Fixed Window algorithm was selected because it is simple, strictly auditable, and easy to reason about. It cleanly maps to the business definition of "Requests Per Minute" and allows for a straightforward atomic Redis implementation.

**Tradeoff:** `10:00:59 → up to N requests`, and `10:01:00 → another N requests`.
This can create a short-lived burst across the minute boundary. This is an intentional consequence of strict calendar-minute semantics rather than a flaw, as the system does not attempt to provide rolling-window smoothing.

## 4. Distributed Correctness

Three application nodes do not multiply the customer's quota.

```text
 Node 1 ─┐
 Node 2 ─┼──→ shared Redis counter
 Node 3 ─┘
```

The entire operation—fetching the counter, checking the limit, incrementing the counter, setting expiration, and returning the decision—is executed atomically in one Redis Lua script. The rate-limit decision for a given Redis key is atomic within Redis, preventing concurrent requests from independently observing the same remaining slot.

## 5. HTTP API

`GET /api/v1/resource`

**Identity:**
Customers are identified by the `X-Customer-Id` header.

**Responses:**
- **Success:** `200 OK` (includes rate-limit headers).
- **Quota exceeded:** `429 Too Many Requests` with a `Retry-After: <seconds>` header. This indicates the customer's quota was known to be exhausted.
- **Missing/unknown customer:** `401 Unauthorized`.
- **Redis/rate-limit infrastructure unavailable:** `503 Service Unavailable`. This indicates the quota could not safely be evaluated (failing closed).

## 6. Rate-Limit Headers

- `X-RateLimit-Limit`: The customer's configured maximum requests for the current minute window.
- `X-RateLimit-Remaining`: The number of requests remaining in the current minute window.
- `X-RateLimit-Reset`: The absolute UTC epoch timestamp (in seconds) when the current window ends and the quota resets.

## 7. Customer Configuration

The configuration model resolves quotas in the following order:
`customer override` → `tier default quota`

Example tiers:
- `Starter` = 60 RPM
- `Growth` = 300 RPM
- `Enterprise` = 300 RPM (default, configurable)

Customer-specific quota changes are executed as configuration changes in `config.js`. This prototype relies on static files; it does not implement a dynamic production admin or configuration-management system.

## 8. Northwind Stakeholder Conflict

**The Contradiction:**
Northwind's contracted quota is 300 RPM. Their actual batch traffic generates 800–1200 RPM. It is impossible to both strictly enforce 300 RPM and guarantee zero 429s for 800–1200 RPM traffic.

**The Resolution:**
The limiter uniformly enforces the configured quota. If the business wants Northwind to sustain higher batch traffic, the business must explicitly configure an appropriately higher quota.

**No Northwind bypass exists.** There is no hidden, time-based exception for Northwind or any other customer. The exact same mechanism is available to every customer. Engineering supplies the robust enforcement mechanism; the commercial decision to raise the quota remains with the business.

## 9. Running Locally

Requires Docker, Docker Compose, and Node.js >= 18.

```bash
# 1. Start the infrastructure (Nginx, 3 Node instances, Redis)
cd solution
npm install
docker compose up -d --build

# 2. Run the automated load harness
npm run harness

# 3. Stop the environment
docker compose down
```

## 10. Load Harness

Execute with: `npm run harness`

The automated harness demonstrates:
- Below quota
- Exactly quota
- Quota + 1
- Customer isolation
- Distributed global quota
- Concurrent distributed load
- Boundary race
- Configuration/Northwind behavior
- Window reset

The harness uses the real `nginx → Node 1/2/3 → Redis` topology. It validates exact HTTP behavior, strictly checks request accounting (`Total == Allowed + Rejected`), and outputs `PASS/FAIL`, exiting non-zero on any failure.

**Example Output Segment:**
```text
──────────────────────────────────────────────
SCENARIO: Quota + 1
──────────────────────────────────────────────
Customer: harness-over
Quota:    10 RPM
Requests: 11
Allowed:  10
Rejected: 1
Nodes:    node-2, node-1, node-3
Headers on last response:
  Status:        429
  Remaining:     0
  Retry-After:   33
Result:   PASS ✓
```

## 11. Tests

Execute with: `npm test`

The test suite covers:
- Unit behavior
- Boundary semantics
- TTL calculations
- Retry-After formatting
- Customer isolation
- Redis failure (503 Service Unavailable)
- HTTP integration
- Concurrency

## 12. Known Limitations / Tradeoffs

- **Fixed-window boundary burst:** The calendar-minute definition permits bursts across adjacent boundaries.
- **Node-local clock:** The prototype uses application-node clocks. All prototype nodes run on one Docker host, but production deployments with significant clock skew would need stronger centralized time semantics.
- **Redis dependency:** The limiter depends on Redis for shared state. If Redis is unavailable, the service fails closed with `503` rather than risk allowing requests without enforcement.
- **Static configuration:** Changing quotas requires configuration/process restart in the prototype.
- **Prototype scope:** This is intentionally a thin vertical slice, not a complete production API platform.
