/**
 * A stand-in for @microsoft/signalr: every built connection is recorded so a test can see its URL, what it joined,
 * and push server events into it. Use with jest.mock("@microsoft/signalr", () => require("./support/fake-signalr")).
 */
type Handler = (...args: any[]) => void;

export class FakeConnection {
  url = "";
  started = false;
  stopped = false;
  invoked: { method: string; args: unknown[] }[] = [];
  handlers = new Map<string, Handler>();
  reconnected: Handler[] = [];
  closed: Handler[] = [];

  async start() {
    this.started = true;
  }
  async stop() {
    this.stopped = true;
  }
  async invoke(method: string, ...args: unknown[]) {
    this.invoked.push({ method, args });
  }
  on(event: string, cb: Handler) {
    this.handlers.set(event, cb);
  }
  onreconnected(cb: Handler) {
    this.reconnected.push(cb);
  }
  onclose(cb: Handler) {
    this.closed.push(cb);
  }
  /** The server announcing a change. */
  emit(event: string, payload: unknown) {
    this.handlers.get(event)?.(payload);
  }
}

export const connections: FakeConnection[] = [];

export class HubConnectionBuilder {
  private url = "";
  withUrl(url: string) {
    this.url = url;
    return this;
  }
  withAutomaticReconnect() {
    return this;
  }
  configureLogging() {
    return this;
  }
  build() {
    const c = new FakeConnection();
    c.url = this.url;
    connections.push(c);
    return c;
  }
}

export const LogLevel = { Warning: 3 };
