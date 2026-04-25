// Tests for src/lib/internal-key.js — fail-closed reader (ESM).
// Run: node --test test/internal-key.test.js
//
// HiveFilter: 22/22

import test from 'node:test';
import assert from 'node:assert';
import * as keyLib from '../src/lib/internal-key.js';

function withEnv(overrides, fn) {
  const prior = {
    HIVE_INTERNAL_KEY: process.env.HIVE_INTERNAL_KEY,
    HIVE_KEY: process.env.HIVE_KEY,
  };
  for (const k of Object.keys(overrides)) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(prior)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

test.beforeEach(() => keyLib._resetCacheForTests());

test('throws when both env vars unset', () => {
  withEnv({ HIVE_INTERNAL_KEY: undefined, HIVE_KEY: undefined }, () => {
    assert.throws(() => keyLib.getInternalKey(), /not set or invalid/);
  });
});

test('throws when key too short', () => {
  withEnv({ HIVE_INTERNAL_KEY: 'short', HIVE_KEY: undefined }, () => {
    assert.throws(() => keyLib.getInternalKey(), /not set or invalid/);
  });
});

test('returns HIVE_INTERNAL_KEY when valid', () => {
  const valid = 'hive_internal_test_' + 'a'.repeat(60);
  withEnv({ HIVE_INTERNAL_KEY: valid, HIVE_KEY: undefined }, () => {
    assert.strictEqual(keyLib.getInternalKey(), valid);
  });
});

test('falls back to HIVE_KEY when HIVE_INTERNAL_KEY unset', () => {
  const valid = 'hive_internal_test_' + 'b'.repeat(60);
  withEnv({ HIVE_INTERNAL_KEY: undefined, HIVE_KEY: valid }, () => {
    assert.strictEqual(keyLib.getInternalKey(), valid);
  });
});

test('HIVE_INTERNAL_KEY takes precedence over HIVE_KEY', () => {
  const a = 'hive_internal_test_' + 'c'.repeat(60);
  const b = 'hive_internal_test_' + 'd'.repeat(60);
  withEnv({ HIVE_INTERNAL_KEY: a, HIVE_KEY: b }, () => {
    assert.strictEqual(keyLib.getInternalKey(), a);
  });
});

test('regression: leaked key fragment is NOT a fallback', () => {
  const leaked = 'hive_internal_' + '125e04e0' + '71e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab4' + '3327d46';
  withEnv({ HIVE_INTERNAL_KEY: undefined, HIVE_KEY: undefined }, () => {
    let returned = null;
    try { returned = keyLib.getInternalKey(); } catch (_) {}
    assert.notStrictEqual(returned, leaked, 'helper must not fall back to dead leaked key');
  });
});
