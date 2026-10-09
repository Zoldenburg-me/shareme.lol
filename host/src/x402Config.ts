type Env = Record<string, string | undefined>;

/** How this host takes x402 payments for keeping links past the plan's limit. */
export interface X402Config {
  /** Address that receives payments. */
  readonly payTo: string;
  /** CAIP-2 chain id, e.g. eip155:8453 for Base. */
  readonly network: string;
  /** Token contract paid in, and its EIP-712 domain (needed by EIP-3009 signers). */
  readonly asset: string;
  readonly assetName: string;
  readonly assetVersion: string;
  readonly assetDecimals: number;
  /** Shown to agents next to prices, e.g. USDC. */
  readonly assetSymbol: string;
  /** Verifies and settles payments: Coinbase's, or a payment orchestrator speaking the x402 facilitator API. */
  readonly facilitatorUrl: string;
  /** Sent as the Authorization header to the facilitator, if it needs one. */
  readonly facilitatorAuth?: string;
  /** Prices in atomic units of the asset, per started 30 days of extra life. */
  readonly pricePerFileMonth: number;
  readonly pricePerGbMonth: number;
  /** Longest a link may live in total, paid time included. */
  readonly maxLifetimeSeconds: number;
  readonly maxTimeoutSeconds: number;
}

const DAY_SECONDS = 86_400;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

// Circle's USDC, whose EIP-712 domain differs by chain.
const KNOWN_ASSETS: Readonly<Record<string, { asset: string; name: string; version: string; decimals: number; symbol: string }>> = {
  "eip155:8453": { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2", decimals: 6, symbol: "USDC" },
  "eip155:84532": { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2", decimals: 6, symbol: "USDC" },
};

function int(env: Env, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be an integer of at least ${min}, got "${raw}"`);
  return value;
}

function facilitatorUrl(raw: string | undefined): string {
  let url: URL | undefined;
  try {
    url = raw ? new URL(raw) : undefined;
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error("X402_FACILITATOR_URL must be the http(s) base URL of an x402 facilitator");
  }
  return url.href.replace(/\/+$/, "");
}

function asset(env: Env, network: string) {
  const known = KNOWN_ASSETS[network];
  const address = env.X402_ASSET || known?.asset;
  const name = env.X402_ASSET_NAME || known?.name;
  const version = env.X402_ASSET_VERSION || known?.version;
  if (!address || !name || !version) {
    throw new Error(`Set X402_ASSET, X402_ASSET_NAME and X402_ASSET_VERSION for network ${network}`);
  }
  if (!ADDRESS.test(address)) throw new Error("X402_ASSET must be a 0x token contract address");
  return {
    asset: address,
    assetName: name,
    assetVersion: version,
    assetDecimals: int(env, "X402_ASSET_DECIMALS", known?.decimals ?? 6, 0),
    assetSymbol: env.X402_ASSET_SYMBOL || known?.symbol || name,
  };
}

/** Undefined (payments off) unless X402_PAY_TO is set. */
export function loadX402Config(env: Env): X402Config | undefined {
  const payTo = env.X402_PAY_TO;
  if (!payTo) return undefined;
  if (!ADDRESS.test(payTo)) throw new Error("X402_PAY_TO must be a 0x address");
  const network = env.X402_NETWORK || "eip155:8453";
  if (!CAIP2.test(network)) throw new Error(`X402_NETWORK must be a CAIP-2 chain id like eip155:8453, got "${network}"`);
  const pricePerFileMonth = int(env, "X402_PRICE_PER_FILE_MONTH", 10_000, 0);
  const pricePerGbMonth = int(env, "X402_PRICE_PER_GB_MONTH", 20_000, 0);
  // A zero price would hand out extensions for free while still asking the facilitator to settle nothing.
  if (pricePerFileMonth + pricePerGbMonth === 0) throw new Error("X402_PRICE_PER_FILE_MONTH and X402_PRICE_PER_GB_MONTH can't both be 0");
  return {
    payTo,
    network,
    ...asset(env, network),
    facilitatorUrl: facilitatorUrl(env.X402_FACILITATOR_URL),
    ...(env.X402_FACILITATOR_AUTH ? { facilitatorAuth: env.X402_FACILITATOR_AUTH } : {}),
    pricePerFileMonth,
    pricePerGbMonth,
    maxLifetimeSeconds: int(env, "X402_MAX_LIFETIME_SECONDS", 365 * DAY_SECONDS),
    maxTimeoutSeconds: int(env, "X402_MAX_TIMEOUT_SECONDS", 120),
  };
}
