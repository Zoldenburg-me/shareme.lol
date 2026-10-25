import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package-lock.json", () => {
  it("hoists every host dependency, since host/Dockerfile ships only the root node_modules", () => {
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    expect(Object.keys(lock.packages).filter((p) => p.startsWith("host/node_modules/"))).toEqual([]);
  });
});
