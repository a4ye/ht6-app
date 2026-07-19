// Unit tests for the SDK-backed add-funds (deposit-address provisioning) flow.
// Unifold network calls are stubbed on the client singleton, so these run fully
// offline (no sk_live, no HTTP to api.unifold.io) — same convention as
// backend.test.ts. Test-only env is preloaded by test/setup-env.mjs.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { addFunds } from '../src/addFunds.js';
import { unifold } from '../src/unifold.js';
import {
  CHAIN_ID,
  TREASURY_ACCOUNT_ID,
  USDC_BASE_TOKEN_ADDRESS,
} from '../src/config.js';

// Shape mirrors the SDK's DepositAddress (resources/DepositAddresses.d.ts).
const BASE_DEPOSIT_ADDRESS = {
  id: 'wallet_base_1',
  chain_type: 'ethereum',
  address_type: null,
  address: '0xDEPOSITADDR',
  destination_chain_type: 'ethereum',
  destination_chain_id: String(CHAIN_ID),
  destination_token_address: USDC_BASE_TOKEN_ADDRESS,
  recipient_address: '0xTREASURYADDR',
  is_primary: true,
  is_transit_wallet: false,
  action_type: 'deposit',
};

// ---- Stub the Unifold client (Stripe-style resource instances) ----
let retrievedAccountIds: string[] = [];
let createCalls: Array<Record<string, unknown>> = [];
let createImpl: () => Promise<{ data: Array<Record<string, unknown>> }>;

const u = unifold as any;
u.treasury.accounts.retrieve = async (id: string) => {
  retrievedAccountIds.push(id);
  return { address: '0xTREASURYADDR', chain_type: 'ethereum' };
};
u.depositAddresses.create = (params: Record<string, unknown>) => {
  createCalls.push(params);
  return createImpl();
};

beforeEach(() => {
  retrievedAccountIds = [];
  createCalls = [];
  createImpl = async () => ({ data: [BASE_DEPOSIT_ADDRESS] });
});

describe('addFunds — SDK deposit-address provisioning', () => {
  test('calls depositAddresses.create with the exact ownedDeposit() tuple', async () => {
    const result = await addFunds('u_addfunds_1');

    // The treasury account is resolved first so deposits route into it.
    assert.deepEqual(retrievedAccountIds, [TREASURY_ACCOUNT_ID]);

    // The typed SDK method gets the exact tuple ownedDeposit() checks.
    assert.equal(createCalls.length, 1);
    assert.deepEqual(createCalls[0], {
      external_user_id: 'u_addfunds_1',
      destination_chain_type: 'ethereum',
      destination_chain_id: String(CHAIN_ID),
      destination_token_address: USDC_BASE_TOKEN_ADDRESS,
      recipient_address: '0xTREASURYADDR',
      action_type: 'deposit',
    });

    // Same return shape/keys the main server + client already consume.
    assert.deepEqual(result, {
      treasuryAddress: '0xTREASURYADDR',
      depositAddresses: [BASE_DEPOSIT_ADDRESS],
    });
  });

  test('returns every provisioned address (one per supported source chain)', async () => {
    const solanaAddress = {
      ...BASE_DEPOSIT_ADDRESS,
      id: 'wallet_solana_1',
      chain_type: 'solana',
      address: 'So1anaDepositAddr11111111111111111111111111',
      is_primary: false,
    };
    createImpl = async () => ({ data: [BASE_DEPOSIT_ADDRESS, solanaAddress] });

    const result = await addFunds('u_addfunds_2');
    assert.deepEqual(result.depositAddresses, [BASE_DEPOSIT_ADDRESS, solanaAddress]);
  });

  test('wraps an SDK failure in a descriptive error', async () => {
    createImpl = async () => {
      throw new Error('unifold boom');
    };

    await assert.rejects(
      () => addFunds('u_addfunds_3'),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('deposit-address provisioning failed') &&
        error.message.includes('u_addfunds_3') &&
        error.message.includes('unifold boom'),
    );
  });
});
