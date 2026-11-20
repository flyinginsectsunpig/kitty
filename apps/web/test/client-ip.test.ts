import { describe, expect, test } from "vitest";
import { forwardedFor } from "@/lib/client-ip";

const from = (value?: string) => new Headers(value === undefined ? {} : { "x-forwarded-for": value });

describe("forwardedFor", () => {
  test("passes on the address the proxy saw when the proxy is trusted", () => {
    expect(forwardedFor(from("203.0.113.7"), true)).toEqual({ "X-Forwarded-For": "203.0.113.7" });
  });

  test("uses the entry the nearest proxy added, not one the client made up", () => {
    expect(forwardedFor(from("10.9.9.9, 203.0.113.7"), true)).toEqual({ "X-Forwarded-For": "203.0.113.7" });
  });

  test("accepts IPv6", () => {
    expect(forwardedFor(from("2001:db8::1"), true)).toEqual({ "X-Forwarded-For": "2001:db8::1" });
  });

  test("sends nothing when the proxy is not trusted", () => {
    expect(forwardedFor(from("203.0.113.7"), false)).toEqual({});
  });

  test("sends nothing when the header is missing or not an address", () => {
    expect(forwardedFor(from(), true)).toEqual({});
    expect(forwardedFor(from("not-an-ip"), true)).toEqual({});
    expect(forwardedFor(from("203.0.113.7, "), true)).toEqual({});
  });
});
