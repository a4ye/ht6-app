// One-time "add funds" (deposit) flow. Creates per-user Unifold deposit addresses
// that route incoming crypto into the project treasury, tagged with external_user_id.
// The webhook (or the /deposits/refresh poll) then credits the user's balance on
// arrival.
import type { DepositAddress } from '@unifold/node';
import {
  TREASURY_ACCOUNT_ID,
  CHAIN_ID,
  USDC_BASE_TOKEN_ADDRESS,
} from './config.js';
import { unifold } from './unifold.js';

export async function addFunds(externalUserId: string): Promise<{
  treasuryAddress: string;
  depositAddresses: DepositAddress[];
}> {
  // Deposits should land in the treasury (where the grant pool lives).
  const acct = await unifold.treasury.accounts.retrieve(TREASURY_ACCOUNT_ID);

  // Alignment contract with ownedDeposit() in deposits.ts: the addresses are
  // provisioned with destination_chain_type 'ethereum', destination_chain_id
  // String(CHAIN_ID), destination_token_address USDC_BASE_TOKEN_ADDRESS (native
  // Circle USDC on Base — the token deposits are converted into), and
  // recipient_address == treasury.address — the exact tuple ownedDeposit()
  // checks — so an arrived deposit credits the user via the webhook or the
  // /deposits/refresh poll.
  try {
    // Response<DepositAddressList> merges the payload onto the result (same
    // convention as `acct.address` above and `page.data` in deposits.ts), so
    // `.data` is the DepositAddress[] — one address per supported source chain.
    const created = await unifold.depositAddresses.create({
      external_user_id: externalUserId,
      destination_chain_type: 'ethereum',
      destination_chain_id: String(CHAIN_ID),
      destination_token_address: USDC_BASE_TOKEN_ADDRESS,
      recipient_address: acct.address,
      action_type: 'deposit',
    });
    return { treasuryAddress: acct.address, depositAddresses: created.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Unifold deposit-address provisioning failed for user ${externalUserId}: ${message}`,
    );
  }
}
