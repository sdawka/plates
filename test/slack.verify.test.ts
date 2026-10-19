import { describe, expect, it } from "vitest";
import { signSlackBody, verifySlackSignature } from "../src/slack/verify";

const secret = "shhh";
const body = "payload=%7B%7D";
const now = 1_700_000_000;

describe("verifySlackSignature", () => {
  it("accepts a correct, fresh signature", async () => {
    const signature = await signSlackBody(secret, String(now), body);
    expect(await verifySlackSignature({ secret, body, timestamp: String(now), signature, nowSeconds: now + 10 })).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await signSlackBody(secret, String(now), body);
    expect(await verifySlackSignature({ secret, body: body + "x", timestamp: String(now), signature, nowSeconds: now })).toBe(false);
  });

  it("rejects a wrong secret and missing headers", async () => {
    const signature = await signSlackBody("other", String(now), body);
    expect(await verifySlackSignature({ secret, body, timestamp: String(now), signature, nowSeconds: now })).toBe(false);
    expect(await verifySlackSignature({ secret, body, timestamp: null, signature: null, nowSeconds: now })).toBe(false);
  });

  it("rejects requests older than 5 minutes (and from the far future)", async () => {
    const signature = await signSlackBody(secret, String(now), body);
    expect(await verifySlackSignature({ secret, body, timestamp: String(now), signature, nowSeconds: now + 301 })).toBe(false);
    expect(await verifySlackSignature({ secret, body, timestamp: String(now), signature, nowSeconds: now - 301 })).toBe(false);
  });
});
