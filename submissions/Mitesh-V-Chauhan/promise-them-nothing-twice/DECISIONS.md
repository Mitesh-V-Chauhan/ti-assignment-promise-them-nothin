# Architecture & Design Decisions

This document outlines the core technical decisions for the RelayAPI distributed rate limiter prototype, addressing requirements from engineering and support stakeholders.

## 1. Rate-Limiting Algorithm
**Decision:** Fixed Window Counter.
**Reasoning:** The assignment explicitly specifies enforcement against "per-customer RPM tiers" and the CTO prioritized a simple, provable, and auditable solution over bespoke counters. A fixed window strictly bounds the number of accepted requests within a predefined timeframe. While a Sliding Window Log offers smoother traffic shaping, it requires O(N) memory and computation per customer. Sliding Window Counter adds complexity without fundamentally changing the strictness of the boundary. Fixed Window is the simplest to implement atomically in Redis and trivial to audit.

## 2. RPM Semantics
**Decision:** One customer's quota strictly applies to one aligned UTC calendar-minute window (e.g., `10:00:00` to `10:00:59`).
**Reasoning:** This creates unambiguous auditability ("Did this customer exceed their quota between 10:00:00 and 10:00:59 UTC?"). 
**Tradeoff:** A fixed calendar-minute boundary permits traffic bursts. A customer with a 100 RPM quota could send 100 requests at `10:00:59` and 100 more at `10:01:00`, effectively sending 200 requests within a two-second window. This is an intentional tradeoff prioritizing literal RPM strictness and simplicity over smoothed traffic shaping.

## 3. Distributed State
**Decision:** Redis.
**Reasoning:** The application nodes are explicitly required to be stateless, and traffic is distributed across them via round-robin. In-memory state on individual nodes would result in a fragmented quota, allowing customers to exceed their limits. Redis acts as a centralized, fast, single source of truth for the shared counters.

## 4. Atomicity
**Decision:** All check-and-increment operations occur atomically inside a single Redis Lua script.
**Reasoning:** Executing `GET`, evaluating the quota limit, and deciding whether to `INCR` via multiple sequential Redis calls creates a severe read-modify-write race condition under concurrent load. By moving the logic into a Lua script, Redis (which is single-threaded) executes the check-and-increment decision atomically, preventing concurrent requests from independently observing the same remaining slot.

## 5. Counter Semantics
**Decision:** The counter exclusively increments for *accepted* requests. Rejected requests (`429`) do not increment the counter.
**Reasoning:** This aligns the counter precisely with the delivered value. If rejected requests incremented the counter, a customer sustaining high traffic would artificially inflate the counter into the thousands, obfuscating the actual number of successfully serviced requests during an audit.

## 6. Clock & TTL Strategy
**Decision:** Node-provided UTC timestamps construct the window ID, and the Lua script calculates the TTL as the seconds remaining in the minute plus a 1-second safety margin.
**Reasoning:** Relying on the application node's clock saves an expensive `TIME` network call to Redis. The 1-second overlap prevents the key from expiring a fraction of a second early due to minor drift between evaluation and expiration, avoiding a reset anomaly. This assumes reasonably synchronized clocks.

## 7. Failure Behavior
**Decision:** If Redis becomes unavailable, the system fails closed and returns `503 Service Unavailable` instead of `429 Too Many Requests` or failing open.
**Reasoning:** The CTO explicitly prefers over-rejecting to under-limiting ("I would rather reject a few extra legitimate requests than let someone blow past quota"). Returning `503` accurately reflects an infrastructure outage without polluting the customer's understanding of their quota usage.

## 8. CTO vs Support Conflict Resolution
**Conflict:** The CTO mandated strict quota enforcement without manual overrides in production code. Support mandated that Northwind Logistics (contracted for 300 RPM) must not receive `429`s during a batch window that generates 800–1200 RPM.
**Decision:** The rate limiter uniformly enforces the configured quota. A business-approved quota increase is represented purely as a configuration change (e.g., updating Northwind's quota to 1200 RPM).
**Reasoning:** It is mathematically impossible to strictly enforce a 300 RPM quota against 1200 RPM traffic without generating `429`s. Any logic that bypasses the limiter for a specific customer violates the CTO's requirement for strict fairness and auditability. The engineering solution provides a robust configuration mechanism. Resolving the contractual misalignment is a commercial business decision, not a codebase exception.

## 9. Why No Northwind Exception?
**Decision:** There is absolutely no production code path that checks for Northwind or implements a time-based bypass.
**Reasoning:** Hardcoding a customer-specific bypass is a dangerous architectural anti-pattern that destroys auditability. The same mechanism applies uniformly to every customer.

## 10. Known Tradeoffs & Limitations
- **Fixed-window bursts:** Permitted as an intentional consequence of the chosen algorithm.
- **Node-local clocks:** The prototype relies on Node.js application clocks. In a multi-host production cluster with significant NTP skew, boundary alignment could diverge slightly between nodes.
- **Redis dependency:** The rate limiter relies entirely on Redis. A Redis outage takes down the API for all customers due to the fail-closed design.
- **Static prototype configuration:** Customer quotas are loaded statically. A GA production deployment would require dynamic configuration loading or a database-backed tier manager to avoid process restarts.
