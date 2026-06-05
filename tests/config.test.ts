import { describe, it, expect } from "vitest";
import { parseCoinSizeMap } from "../src/config.js";

describe("parseCoinSizeMap", () => {
  it("parses a well-formed map", () => {
    expect(parseCoinSizeMap("BTC:2,ETH:2,SOL:2,HYPE:1.5")).toEqual({
      BTC: 2,
      ETH: 2,
      SOL: 2,
      HYPE: 1.5,
    });
  });

  it("returns an empty object for empty / whitespace input", () => {
    expect(parseCoinSizeMap("")).toEqual({});
    expect(parseCoinSizeMap("   ")).toEqual({});
  });

  it("upper-cases coin keys and trims whitespace", () => {
    expect(parseCoinSizeMap(" btc : 3 , eth:1 ")).toEqual({ BTC: 3, ETH: 1 });
  });

  it("tolerates a trailing comma / empty segments", () => {
    expect(parseCoinSizeMap("BTC:2,")).toEqual({ BTC: 2 });
  });

  it("throws on a missing colon", () => {
    expect(() => parseCoinSizeMap("BTC2")).toThrow();
  });

  it("throws on a non-numeric size", () => {
    expect(() => parseCoinSizeMap("BTC:abc")).toThrow();
  });

  it("throws on a non-positive size", () => {
    expect(() => parseCoinSizeMap("BTC:0")).toThrow();
    expect(() => parseCoinSizeMap("BTC:-1")).toThrow();
  });

  it("throws on an empty coin", () => {
    expect(() => parseCoinSizeMap(":2")).toThrow();
  });
});
