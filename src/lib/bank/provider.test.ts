import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bankMode, providerFor, requirePlaid, resetProviderLog } from "./provider";

const NAMES = ["PLAID_CLIENT_ID", "PLAID_SECRET", "TOKEN_ENC_KEY", "TOKEN_ENC_KEY_PREVIOUS", "BANK_PROVIDER"] as const;
const saved = Object.fromEntries(NAMES.map(n => [n, process.env[n]]));
const key = () => randomBytes(32).toString("base64");
let lines: string[];

beforeEach(() => {
  for (const n of NAMES) delete process.env[n];
  resetProviderLog();
  lines = [];
  vi.spyOn(console, "log").mockImplementation((l) => void lines.push(String(l)));
  vi.spyOn(console, "error").mockImplementation((l) => void lines.push(String(l)));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
});

describe("bank provider selection", () => {
  it("is the demo bank when no Plaid keys are set, and the log says so once without values", () => {
    expect(bankMode()).toBe("demo");
    expect(bankMode()).toBe("demo");
    const fallback = lines.filter(l => l.includes("bank.provider.fallback"));
    expect(fallback).toHaveLength(1);
    expect(JSON.parse(fallback[0])).toMatchObject({ reason: "unconfigured", missing: ["PLAID_CLIENT_ID", "PLAID_SECRET", "TOKEN_ENC_KEY"] });
    expect(providerFor("demo").name).toBe("demo");
    expect(() => requirePlaid()).toThrowError(expect.objectContaining({ status: 409 }));
  });

  it("is plaid only when all three are present and the key is valid", () => {
    process.env.PLAID_CLIENT_ID = "cid"; process.env.PLAID_SECRET = "sec"; process.env.TOKEN_ENC_KEY = key();
    expect(bankMode()).toBe("plaid");
    expect(providerFor("plaid").name).toBe("plaid");
    expect(lines.filter(l => l.includes("bank.provider.fallback"))).toHaveLength(0);
  });

  it("falls back to demo when any one of the three is missing", () => {
    const all = { PLAID_CLIENT_ID: "cid", PLAID_SECRET: "sec", TOKEN_ENC_KEY: key() };
    for (const missing of Object.keys(all) as (keyof typeof all)[]) {
      resetProviderLog();
      for (const n of NAMES) delete process.env[n];
      Object.assign(process.env, all);
      delete process.env[missing];
      expect(bankMode()).toBe("demo");
    }
    expect(lines.some(l => l.includes('"reason":"partial"'))).toBe(true);
  });

  it("falls back to demo for a 31-byte, 33-byte or non-base64 TOKEN_ENC_KEY, and never prints it", () => {
    process.env.PLAID_CLIENT_ID = "cid"; process.env.PLAID_SECRET = "sec";
    for (const bad of [randomBytes(31).toString("base64"), randomBytes(33).toString("base64"), "not base64 at all!!"]) {
      resetProviderLog(); lines.length = 0;
      process.env.TOKEN_ENC_KEY = bad;
      expect(bankMode()).toBe("demo");
      expect(() => requirePlaid()).toThrowError(expect.objectContaining({ status: 409 }));
      const out = lines.join("\n");
      expect(out).toContain('"invalid":["TOKEN_ENC_KEY"]');
      expect(out).not.toContain(bad);
    }
  });

  it("names the variable actually at fault, so a bad previous key is not blamed on the current one", () => {
    process.env.PLAID_CLIENT_ID = "cid"; process.env.PLAID_SECRET = "sec"; process.env.TOKEN_ENC_KEY = key();
    process.env.TOKEN_ENC_KEY_PREVIOUS = randomBytes(31).toString("base64");
    expect(bankMode()).toBe("demo");
    expect(lines.join("\n")).toContain('"invalid":["TOKEN_ENC_KEY_PREVIOUS"]');
    resetProviderLog(); lines.length = 0;
    process.env.TOKEN_ENC_KEY_PREVIOUS = process.env.TOKEN_ENC_KEY; // identical keys: also the previous one's fault
    expect(bankMode()).toBe("demo");
    expect(lines.join("\n")).toContain('"invalid":["TOKEN_ENC_KEY_PREVIOUS"]');
  });

  it("BANK_PROVIDER=demo forces the demo bank even with every key present", () => {
    process.env.PLAID_CLIENT_ID = "cid"; process.env.PLAID_SECRET = "sec"; process.env.TOKEN_ENC_KEY = key(); process.env.BANK_PROVIDER = "demo";
    expect(bankMode()).toBe("demo");
    expect(() => requirePlaid()).toThrowError(expect.objectContaining({ status: 409 }));
    expect(() => providerFor("plaid")).toThrow();
  });
});
