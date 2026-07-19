// Env for the money-flow simulation (scripts/simulate-flow.ts). Same offline,
// non-secret setup as the test suite, but WITHOUT pinning the cash-out minimum,
// so the sim runs against the real shipping default ($1). No real credentials.
process.env.NODE_ENV = 'test';
process.env.CRYPTO_STORE_BACKEND = 'json';
process.env.DATA_DIR = '.data-test';
process.env.UNIFOLD_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.TREASURY_ACCOUNT_ID = 'ta_test_not_a_real_account';
process.env.CRYPTO_SERVICE_TOKEN = 'test-only-crypto-service-token-0123456789abcdef';
