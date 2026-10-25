import { describe, expect, it } from "vitest";
import { isPatchedNode } from "../src/nodeVersion.js";

describe("isPatchedNode", () => {
  it("accepts the first patched release of each line and later ones", () => {
    for (const v of ["22.23.4", "v22.24.0", "24.22.1", "24.23.0", "26.12.1", "26.13.0", "27.0.0", "22.23.5-rc.1", "24.22.2-rc.1", "v26.12.2-rc.1", "26.13.0-v8-canary20261101abc", "26.13.0-nightly20261101abc", "22.23.4+build.7"]) expect(isPatchedNode(v)).toBe(true);
  });

  it("rejects older releases, end-of-life lines and odd lines", () => {
    for (const v of ["22.23.3", "v22.17.0", "22.22.99", "24.22.0", "24.21.9", "26.12.0", "26.11.99", "20.19.5", "23.11.0", "25.2.0", "", "abc", "22.23.4-rc.1", "24.22.1-rc.1", "v26.12.1-rc.1", "22.23", "22.23.4.1", " 22.23.4", "1e3.0.0", "22.x.9"]) expect(isPatchedNode(v)).toBe(false);
  });
});
