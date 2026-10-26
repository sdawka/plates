import { describe, expect, it } from "vitest";
import { JEV_THRESHOLDS, modelFamily, thresholdsFor } from "../src/thresholds";

describe("thresholdsFor", () => {
  it("falls back to the Jev defaults for unknown and missing models", () => {
    expect(thresholdsFor(undefined)).toEqual(JEV_THRESHOLDS);
    expect(thresholdsFor("vendor/never-seen-9")).toEqual(JEV_THRESHOLDS);
  });

  it("resolves a versioned id through its family", () => {
    expect(thresholdsFor("typesafe/jev-1.14")).toEqual(JEV_THRESHOLDS);
    expect(modelFamily("typesafe/jev-1.14")).toBe("typesafe/jev");
    expect(modelFamily("cloudflare/clef-flash")).toBe("cloudflare/clef-flash");
    expect(modelFamily("perplexity/pplx-decider-v1.2")).toBe("perplexity/pplx-decider-v1.2");
    expect(modelFamily("liquid/d1")).toBe("liquid/d1");
  });

  it("returns a fresh object each time so callers can't mutate the defaults", () => {
    const a = thresholdsFor("typesafe/jev-1.14");
    a.AUTO_P = 0.1;
    expect(thresholdsFor("typesafe/jev-1.14").AUTO_P).toBe(JEV_THRESHOLDS.AUTO_P);
  });
});
