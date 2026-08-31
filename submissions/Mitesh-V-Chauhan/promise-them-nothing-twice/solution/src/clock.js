'use strict';

/**
 * clock.js — Injectable clock for the rate limiter.
 *
 * Production code uses the system clock.
 * Tests can inject a deterministic clock to avoid real-time waits
 * and to test window boundary behavior precisely.
 */

/**
 * Returns the current time as an integer Unix timestamp (seconds since epoch, UTC).
 * This is the default (production) clock.
 */
function systemClock() {
  return Math.floor(Date.now() / 1000);
}

module.exports = { systemClock };
