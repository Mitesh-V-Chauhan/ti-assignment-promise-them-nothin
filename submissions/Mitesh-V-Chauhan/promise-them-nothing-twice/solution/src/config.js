'use strict';

/**
 * config.js — Customer and tier configuration for RelayAPI rate limiting.
 *
 * Design decisions (from Phase 1):
 * - Tier-based defaults with per-customer RPM overrides
 * - Quota resolved: customer.rpm (if set) → tier.rpm (fallback)
 * - No customer-specific code paths — all customers use the same resolution logic
 * - A quota change for any customer (including Northwind) is a config change, not a code change
 */

const tiers = {
  starter: { rpm: 60 },
  growth: { rpm: 300 },
  enterprise: { rpm: 300 },  // default for enterprise; individual customers can override
};

const customers = {
  'customer-1': {
    name: 'Acme Corp',
    tier: 'starter',
    // No rpm override → uses tier default (60 RPM)
  },
  'customer-2': {
    name: 'Beta Inc',
    tier: 'growth',
    // No rpm override → uses tier default (300 RPM)
  },
  'northwind': {
    name: 'Northwind Logistics',
    tier: 'enterprise',
    // Contracted 300 RPM
  },
  // --- HARNESS TEST CUSTOMERS ---
  'harness-below': { tier: 'starter', rpm: 10 },
  'harness-exact': { tier: 'starter', rpm: 10 },
  'harness-over': { tier: 'starter', rpm: 10 },
  'harness-iso-a': { tier: 'starter', rpm: 10 },
  'harness-iso-b': { tier: 'starter', rpm: 10 },
  'harness-dist': { tier: 'starter', rpm: 100 },
  'harness-conc': { tier: 'starter', rpm: 100 },
  'harness-race': { tier: 'starter', rpm: 10 },
  'harness-reset': { tier: 'starter', rpm: 10 },
  'harness-nw-300': { tier: 'enterprise', rpm: 300 },
  'harness-nw-1200': { tier: 'enterprise', rpm: 1200 },
};

/**
 * Resolve the RPM quota for a given customer ID.
 *
 * Resolution order:
 *   1. customer.rpm (explicit per-customer override)
 *   2. tiers[customer.tier].rpm (tier default)
 *
 * @param {string} customerId
 * @returns {{ rpm: number, tier: string, name: string } | null}
 *   null if customer is unknown
 */
function resolveQuota(customerId) {
  const customer = customers[customerId];
  if (!customer) {
    return null;
  }

  const tier = tiers[customer.tier];
  if (!tier) {
    return null;
  }

  const rpm = customer.rpm !== undefined ? customer.rpm : tier.rpm;

  return {
    customerId,
    name: customer.name,
    tier: customer.tier,
    rpm,
  };
}

/**
 * Get all configured customer IDs.
 * @returns {string[]}
 */
function getCustomerIds() {
  return Object.keys(customers);
}

module.exports = { tiers, customers, resolveQuota, getCustomerIds };
