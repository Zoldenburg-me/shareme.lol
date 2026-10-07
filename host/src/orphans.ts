import type { FileStore } from "./store.js";
import type { TokenStore } from "./tokens.js";

/**
 * Delete files whose owner token no longer exists, e.g. after a crash between a revoke and its
 * file cascade. An empty registry more likely means tokens.json went missing than that every
 * token was revoked, so it never counts as "all owners gone".
 */
export async function purgeOrphanedFiles(store: FileStore, tokens: TokenStore): Promise<number> {
  if (tokens.count() === 0) return 0;
  return store.deleteOrphans((owner) => tokens.hasId(owner));
}
