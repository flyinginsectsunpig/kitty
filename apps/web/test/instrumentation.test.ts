import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registerOTel = vi.fn();
vi.mock("@vercel/otel", () => ({ registerOTel }));

import { register } from "@/instrumentation";

describe("server-side telemetry", () => {
  const saved = { ...process.env };
  beforeEach(() => registerOTel.mockClear());
  afterEach(() => {
    process.env = { ...saved };
  });

  it("registers with the service name when an endpoint is set", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector.observability:4318";
    process.env.OTEL_SERVICE_NAME = "web";
    process.env.NEXT_RUNTIME = "nodejs";
    await register();
    expect(registerOTel).toHaveBeenCalledWith({ serviceName: "web" });
  });

  it("does nothing without an endpoint", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.NEXT_RUNTIME = "nodejs";
    await register();
    expect(registerOTel).not.toHaveBeenCalled();
  });

  it("does nothing on the edge runtime", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector.observability:4318";
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(registerOTel).not.toHaveBeenCalled();
  });
});
