/** What an in-progress upload holds: bytes against the quotas, and one file slot for its owner. */
interface Hold {
  readonly bytes: number;
  readonly owner?: string;
}

/**
 * Storage held by uploads that are still streaming. Quota checks add these to the stored totals,
 * so parallel uploads can't each see the same free space and together overrun it.
 */
export class Reservations {
  private holds: ReadonlySet<Hold> = new Set();

  totalBytes(): number {
    return [...this.holds].reduce((sum, h) => sum + h.bytes, 0);
  }

  ownerBytes(owner: string): number {
    return [...this.holds].filter((h) => h.owner === owner).reduce((sum, h) => sum + h.bytes, 0);
  }

  ownerFiles(owner: string): number {
    return [...this.holds].filter((h) => h.owner === owner).length;
  }

  /** Hold `bytes` until the returned release is called (calling it again does nothing). */
  hold(bytes: number, owner?: string): () => void {
    const hold: Hold = owner === undefined ? { bytes } : { bytes, owner };
    this.holds = new Set([...this.holds, hold]);
    return () => {
      this.holds = new Set([...this.holds].filter((h) => h !== hold));
    };
  }
}
