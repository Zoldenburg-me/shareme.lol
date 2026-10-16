type Env = Record<string, string | undefined>;

/** How this host takes x402 payments for keeping links past the plan's limit. It settles them itself. */
export interface X402Config {
  /** Address that receives payments. */
  readonly payTo: string;
  /** CAIP-2 chain id; only Base Sepolia for now. */
  readonly network: string;
  readonly chainId: number;
  /** Token contract paid in. Its EIP-712 domain is pinned by @zold/accept. */
  readonly asset: string;
  readonly assetDecimals: number;
  /** Shown to agents next to prices, e.g. USDC. */
  readonly assetSymbol: string;
  /** JSON-RPC endpoint the host reads the chain and submits through. May hold an API key: never log it. */
  readonly rpcUrl: string;
  /** Key of an account that only pays gas for submitting payers' transfers. Never log it. */
  readonly gasPrivateKey: `0x${string}`;
  /** Caps per submitted transfer: gas limit, and fee per gas in wei. */
  readonly maxGas: bigint;
  readonly maxFeePerGas: bigint;
  /** Prices in atomic units of the asset, per started 30 days of extra life. */
  readonly pricePerFileMonth: number;
  readonly pricePerGbMonth: number;
  /** Longest a link may live in total, paid time included. */
  readonly maxLifetimeSeconds: number;
  readonly maxTimeoutSeconds: number;
}

const DAY_SECONDS = 86_400;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
// shortcut: Base Sepolia only until the seller side has run against a live chain; add Base (8453) then.
const CHAINS: Readonly<Record<string, { chainId: number; asset: string; decimals: number; symbol: string }>> = {
  "eip155:84532": { chainId: 84532, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, symbol: "USDC" },
};
const DEFAULT_NETWORK = "eip155:84532";
// @zold/accept refuses offers valid for less than a minute or more than four.
const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 240;

function int(env: Env, name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
  return value;
}

function bigint(env: Env, name: string, fallback: bigint): bigint {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9]\d{0,30}$/.test(raw)) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return BigInt(raw);
}

function rpcUrl(raw: string | undefined): string {
  let url: URL | undefined;
  try {
    url = raw ? new URL(raw) : undefined;
  } catch {
    url = undefined;
  }
  // The value is not echoed: an RPC URL often carries an API key.
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) throw new Error("X402_RPC_URL must be the http(s) URL of a JSON-RPC endpoint");
  return url.href;
}

/** Undefined (payments off) unless X402_PAY_TO is set. */
export function loadX402Config(env: Env): X402Config | undefined {
  const payTo = env.X402_PAY_TO;
  if (!payTo) return undefined;
  if (!ADDRESS.test(payTo) || /^0x0{40}$/.test(payTo)) throw new Error("X402_PAY_TO must be a non-zero 0x address");
  const network = env.X402_NETWORK || DEFAULT_NETWORK;
  const chain = CHAINS[network];
  if (!chain) throw new Error(`X402_NETWORK must be ${Object.keys(CHAINS).join(" or ")} (Base Sepolia) for now, got "${network}"`);
  const gasKey = env.X402_GAS_PRIVATE_KEY; // gitleaks:allow (reads the env var; no value here)
  if (!gasKey || !PRIVATE_KEY.test(gasKey)) {
    throw new Error("X402_GAS_PRIVATE_KEY must be the 0x-prefixed 32-byte key of an account holding only ETH for gas");
  }
  const pricePerFileMonth = int(env, "X402_PRICE_PER_FILE_MONTH", 10_000, 0);
  const pricePerGbMonth = int(env, "X402_PRICE_PER_GB_MONTH", 20_000, 0);
  // A zero price would hand out extensions for free; @zold/accept refuses it anyway.
  if (pricePerFileMonth + pricePerGbMonth === 0) throw new Error("X402_PRICE_PER_FILE_MONTH and X402_PRICE_PER_GB_MONTH can't both be 0");
  return {
    payTo,
    network,
    chainId: chain.chainId,
    asset: chain.asset,
    assetDecimals: chain.decimals,
    assetSymbol: chain.symbol,
    rpcUrl: rpcUrl(env.X402_RPC_URL),
    gasPrivateKey: gasKey as `0x${string}`,
    maxGas: bigint(env, "X402_MAX_GAS", 150_000n),
    maxFeePerGas: bigint(env, "X402_MAX_FEE_PER_GAS", 10_000_000_000n),
    pricePerFileMonth,
    pricePerGbMonth,
    maxLifetimeSeconds: int(env, "X402_MAX_LIFETIME_SECONDS", 365 * DAY_SECONDS),
    maxTimeoutSeconds: int(env, "X402_MAX_TIMEOUT_SECONDS", 120, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
  };
}
