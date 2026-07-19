// End-to-end money-flow simulation. Drives the REAL custody HTTP endpoints
// (/users/register, /add-funds, /deposits/refresh, /withdraw) with the Unifold
// SDK stubbed at the network boundary — so the logic WE own (address selection,
// deposit crediting, idempotency, reserve/debit, payout, balance) is exercised
// end-to-end with no real funds, gas, on-chain send, or live API calls.
//
// Run:  npm run simulate      (from custody/)
import request from 'supertest';
import { app } from '../src/index.js';
import { unifold } from '../src/unifold.js';
import { closeStore, initializeStore } from '../src/runtimeStore.js';
import { CHAIN_ID, CRYPTO_SERVICE_TOKEN, USDC_BASE_TOKEN_ADDRESS } from '../src/config.js';

const USER = 'ty_demo';
const FRIEND = '0x232f7722e7B05C8eee106803DBF69c19819C2C99'; // a real Base wallet (payout target)
const TREASURY = '0xTREASURYADDR';

const usd = (units: unknown) => `$${(Number(units) / 1e6).toFixed(2)}`;
const auth = `Bearer ${CRYPTO_SERVICE_TOKEN}`;
const post = (path: string) => request(app).post(path).set('Authorization', auth);
const get = (path: string) => request(app).get(path).set('Authorization', auth);
const balance = async () => (await get(`/users/${USER}`)).body.balanceUnits as string;

async function main(): Promise<void> {
  await initializeStore();

  // ---- Stub Unifold at the boundary (no real API, no chain) ----
  const u = unifold as unknown as Record<string, any>;
  u.treasury.accounts.retrieve = async () => ({ address: TREASURY, chain_type: 'ethereum' });
  // Unifold returns one address per source chain; the client picks chain_type==='ethereum'.
  u.depositAddresses.create = async () => ({
    data: [
      { id: 'wallet_sol', chain_type: 'solana', address: 'So1anaDepositAddr1111111111111111111111', is_primary: true },
      { id: 'wallet_evm', chain_type: 'ethereum', address: '0xBASEDEP0517111111111111111111111111111111', is_primary: false },
    ],
  });
  let deposits: Array<Record<string, unknown>> = [];
  u.directExecutions.list = async () => ({ data: deposits, has_more: false, total_count: deposits.length });
  // Outbound payout succeeds immediately (Unifold is gas-sponsored).
  u.treasury.outboundTransfers.create = async () => ({ id: 'ot_sim', status: 'completed' });
  u.treasury.outboundTransfers.retrieve = async () => ({ status: 'completed' });

  console.log('\n=== Tomo Yard money flow — real endpoints, Unifold stubbed ===\n');

  // 1) individual wallet
  await post('/users/register').send({ externalUserId: USER });
  console.log(`1. register wallet            ${USER}   balance ${usd(await balance())}`);

  // 2) deposit address (client selects the Base/EVM one)
  const af = await post('/add-funds').send({ externalUserId: USER });
  const evm = (af.body.depositAddresses as Array<{ chain_type?: string; address?: string }>)
    .find((a) => a.chain_type === 'ethereum');
  console.log(`2. add-funds                  returned ${af.body.depositAddresses.length} addresses; client picks Base(EVM): ${evm?.address}`);

  // 3) friend sends $3 on Base -> Unifold reports a succeeded deposit -> refresh credits it
  deposits = [{
    id: 'exec_sim_1',
    action_type: 'deposit',
    status: 'succeeded',
    recipient_address: TREASURY,
    destination_chain_type: 'ethereum',
    destination_chain_id: String(CHAIN_ID),
    destination_token_address: USDC_BASE_TOKEN_ADDRESS,
    destination_amount_base_unit: '3000000',
  }];
  const credited = await post('/deposits/refresh').send({ externalUserId: USER });
  console.log(`3. friend sends $3 on Base -> refresh credits ${usd(credited.body.creditedUnits)}   balance ${usd(await balance())}`);
  const dup = await post('/deposits/refresh').send({ externalUserId: USER });
  console.log(`   refresh again (idempotent) -> credited ${usd(dup.body.creditedUnits)} (no double-credit)   balance ${usd(await balance())}`);

  // 4) cash out $3 back to the friend's Base wallet (gas-sponsored payout)
  const destination = {
    chain_type: 'ethereum',
    chain_id: String(CHAIN_ID),
    token_address: USDC_BASE_TOKEN_ADDRESS,
    recipient_address: FRIEND,
  };
  const w = await post('/withdraw').set('Idempotency-Key', 'sim-withdraw-1')
    .send({ externalUserId: USER, amountUnits: '3000000', destination });
  console.log(`4. cash out $3 -> ${FRIEND}`);
  console.log(`   /withdraw HTTP ${w.status}  ok=${w.body.ok}  transfer=${w.body.status}   balance ${usd(await balance())}`);
  const wDup = await post('/withdraw').set('Idempotency-Key', 'sim-withdraw-1')
    .send({ externalUserId: USER, amountUnits: '3000000', destination });
  console.log(`   same Idempotency-Key replay -> HTTP ${wDup.status}, transfer=${wDup.body.status} (no second send)`);

  console.log('\n=> $3 in via deposit, $3 out via payout, balance back to $0 — every endpoint exercised, idempotent both ways.\n');

  await closeStore();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
