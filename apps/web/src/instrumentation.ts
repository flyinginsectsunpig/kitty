// Next.js calls register() once per server start. Server-side OpenTelemetry (phase 5b): traces of the web app's own
// requests and its calls to the ledger and ai services, sent over OTLP to the collector, which scrubs before
// anything leaves the server. Configured only by the standard OTEL_* variables: without
// OTEL_EXPORTER_OTLP_ENDPOINT, nothing is set up. Never in the browser and never on the edge runtime.
export async function register(): Promise<void> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerOTel } = await import("@vercel/otel");
  registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME ?? "web" });
}
