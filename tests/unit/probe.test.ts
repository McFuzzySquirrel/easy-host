import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROBE_DEFAULTS,
  PROBE_FAILURE_CODES,
  type ProbeClock,
  type ProbeFetch,
  type ProbeTimer,
  probeApp,
  probeHealth,
} from "../../src/health/probe.js";

interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/**
 * A virtual clock. With `autoAdvance`, each interval wait moves time forward
 * immediately, so a 90-second budget runs in milliseconds. Without it, tests
 * advance time explicitly to fire a per-attempt timeout.
 */
class FakeClock implements ProbeClock {
  private current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private readonly autoAdvance: boolean;

  constructor(options: { autoAdvance?: boolean } = {}) {
    this.autoAdvance = options.autoAdvance ?? false;
  }

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, ms: number): ProbeTimer {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.current + ms, callback });
    return { handle: id };
  }

  clearTimeout(timer: ProbeTimer): void {
    this.timers.delete(timer.handle as number);
  }

  sleep(ms: number): Promise<void> {
    if (this.autoAdvance) {
      this.advance(ms);
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.setTimeout(resolve, ms);
    });
  }

  advance(ms: number): void {
    const target = this.current + ms;

    for (;;) {
      const next = this.earliestDue(target);
      if (next === undefined) {
        break;
      }
      this.timers.delete(next.id);
      this.current = next.at;
      next.callback();
    }

    this.current = target;
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  private earliestDue(limit: number): { id: number; at: number; callback: () => void } | undefined {
    let best: { id: number; at: number; callback: () => void } | undefined;

    for (const [id, timer] of this.timers) {
      if (timer.at > limit) {
        continue;
      }
      if (best === undefined || timer.at < best.at || (timer.at === best.at && id < best.id)) {
        best = { id, at: timer.at, callback: timer.callback };
      }
    }

    return best;
  }
}

function listen(server: NetServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function portOf(server: NetServer): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected the test server to have a TCP address");
  }
  return address.port;
}

function trackSockets(server: NetServer): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

function closeServer(server: NetServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }

  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function startHttpServer(handler: HttpHandler): Promise<RunningServer> {
  const server = createHttpServer(handler);
  const sockets = trackSockets(server);
  await listen(server);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await closeServer(server, sockets);
  };

  cleanups.push(close);
  const port = portOf(server);
  return { port, close };
}

async function startTcpServer(): Promise<RunningServer> {
  const server = createNetServer((socket) => {
    socket.end();
  });
  const sockets = trackSockets(server);
  await listen(server);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await closeServer(server, sockets);
  };

  cleanups.push(close);
  const port = portOf(server);
  return { port, close };
}

async function reserveUnusedPort(): Promise<number> {
  const server = createNetServer();
  await listen(server);
  const port = portOf(server);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined || error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });

  return port;
}

describe("probe defaults", () => {
  it("uses the documented 2s interval, 5s attempt timeout, and 90s budget", () => {
    expect(PROBE_DEFAULTS).toEqual({
      kind: "http",
      healthPath: "/",
      intervalMs: 2000,
      timeoutMs: 5000,
      startupMs: 90_000,
    });
  });
});

describe("HTTP probe", () => {
  it("succeeds on the first 2xx response and reports attempts, status, and elapsed time", async () => {
    const clock = new FakeClock({ autoAdvance: true });
    let seenPath: string | undefined;
    const server = await startHttpServer((request, response) => {
      seenPath = request.url;
      response.statusCode = 200;
      response.end("ok");
    });

    const result = await probeHealth({
      port: server.port,
      healthPath: "/healthz",
      clock,
    });

    expect(seenPath).toBe("/healthz");
    expect(result.state).toBe("healthy");
    expect(result.healthy).toBe(true);
    expect(result.kind).toBe("http");
    expect(result.port).toBe(server.port);
    expect(result.target).toBe(`http://127.0.0.1:${server.port}/healthz`);
    expect(result.attempts).toBe(1);
    expect(result.elapsedMs).toBe(0);
    expect(result.lastStatus).toBe(200);
    expect(result.lastError).toBeUndefined();
    expect(result.intervalMs).toBe(2000);
    expect(result.timeoutMs).toBe(5000);
    expect(result.startupMs).toBe(90_000);
  });

  it("treats a 3xx response as healthy without following the redirect", async () => {
    const clock = new FakeClock({ autoAdvance: true });
    let redirectTargetHits = 0;
    const server = await startHttpServer((request, response) => {
      if (request.url === "/ok") {
        redirectTargetHits += 1;
        response.statusCode = 200;
        response.end("followed");
        return;
      }
      response.statusCode = 302;
      response.setHeader("location", "/ok");
      response.end("moved");
    });

    const result = await probeHealth({
      port: server.port,
      healthPath: "/redirect",
      clock,
    });

    expect(result.healthy).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.lastStatus).toBe(302);
    expect(redirectTargetHits).toBe(0);
  });

  it.each([404, 500])("treats HTTP %i as a failed attempt", async (status) => {
    const clock = new FakeClock({ autoAdvance: true });
    const server = await startHttpServer((_request, response) => {
      response.statusCode = status;
      response.end("SECRET_TOKEN=must-not-leak");
    });

    const result = await probeHealth({
      port: server.port,
      intervalMs: 500,
      startupMs: 1000,
      clock,
    });

    expect(result.state).toBe("unhealthy");
    expect(result.healthy).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.lastStatus).toBe(status);
    expect(result.lastError).toMatchObject({
      kind: "http-status",
      code: PROBE_FAILURE_CODES.HTTP_STATUS,
      message: `HTTP ${status}`,
      status,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("succeeds after retries at the declared interval", async () => {
    const clock = new FakeClock({ autoAdvance: true });
    let requests = 0;
    const server = await startHttpServer((_request, response) => {
      requests += 1;
      response.statusCode = requests < 3 ? 503 : 200;
      response.end();
    });

    const result = await probeHealth({
      port: server.port,
      intervalMs: 2000,
      startupMs: 30_000,
      clock,
    });

    expect(result.healthy).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.elapsedMs).toBe(4000);
    expect(result.lastStatus).toBe(200);
    expect(requests).toBe(3);
  });

  it("reports connection refused and stops at the startup budget", async () => {
    const clock = new FakeClock({ autoAdvance: true });
    const port = await reserveUnusedPort();

    const result = await probeHealth({
      port,
      intervalMs: 100,
      startupMs: 1000,
      clock,
    });

    expect(result.healthy).toBe(false);
    expect(result.attempts).toBe(10);
    expect(result.elapsedMs).toBe(1000);
    expect(result.lastStatus).toBeUndefined();
    expect(result.lastError).toMatchObject({
      kind: "connection-refused",
      code: PROBE_FAILURE_CODES.CONNECTION_REFUSED,
      message: "connection refused",
    });
  });

  it("fails a half-open request at the per-attempt timeout", async () => {
    const clock = new FakeClock();
    const server = await startHttpServer(() => {
      // Never respond: the attempt must be aborted by its own timer.
    });

    const pending = probeHealth({
      port: server.port,
      intervalMs: 2000,
      timeoutMs: 5000,
      startupMs: 5000,
      clock,
    });
    clock.advance(5000);
    const result = await pending;

    expect(result.healthy).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.elapsedMs).toBe(5000);
    expect(result.lastError).toMatchObject({
      kind: "timeout",
      code: PROBE_FAILURE_CODES.TIMEOUT,
      timeoutMs: 5000,
    });
    expect(result.lastError?.message).toContain("5000");
    expect(clock.pendingTimers).toBe(0);
  });

  it("does not wait for a client that ignores the abort signal", async () => {
    const clock = new FakeClock();
    let captured: AbortSignal | undefined;
    const hangingFetch: ProbeFetch = (_url, init) => {
      captured = init.signal;
      return new Promise<Response>(() => undefined);
    };

    const pending = probeHealth({
      port: 8080,
      timeoutMs: 5000,
      startupMs: 5000,
      clock,
      fetch: hangingFetch,
    });
    clock.advance(5000);
    const result = await pending;

    expect(captured?.aborted).toBe(true);
    expect(result.healthy).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.elapsedMs).toBe(5000);
    expect(result.lastError?.kind).toBe("timeout");
    expect(clock.pendingTimers).toBe(0);
  });

  it("never retries past the 90s budget with the default timings", async () => {
    const clock = new FakeClock({ autoAdvance: true });
    const server = await startHttpServer((_request, response) => {
      response.statusCode = 503;
      response.end("still starting");
    });

    const result = await probeHealth({ port: server.port, clock });

    expect(result.healthy).toBe(false);
    expect(result.attempts).toBe(45);
    expect(result.elapsedMs).toBe(90_000);
    expect(result.intervalMs).toBe(2000);
    expect(result.timeoutMs).toBe(5000);
    expect(result.startupMs).toBe(90_000);
    expect(result.lastError?.kind).toBe("http-status");
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("TCP probe", () => {
  it("succeeds when 127.0.0.1:<port> accepts a connection", async () => {
    const clock = new FakeClock({ autoAdvance: true });
    const server = await startTcpServer();

    const result = await probeHealth({
      port: server.port,
      probe: "tcp",
      clock,
    });

    expect(result.healthy).toBe(true);
    expect(result.state).toBe("healthy");
    expect(result.kind).toBe("tcp");
    expect(result.target).toBe(`tcp://127.0.0.1:${server.port}`);
    expect(result.attempts).toBe(1);
    expect(result.elapsedMs).toBe(0);
    expect(result.lastStatus).toBeUndefined();
    expect(result.lastError).toBeUndefined();
  });

  it("reports a refused TCP connection as unhealthy", async () => {
    const clock = new FakeClock({ autoAdvance: true });
    const port = await reserveUnusedPort();

    const result = await probeHealth({
      port,
      probe: "tcp",
      intervalMs: 100,
      startupMs: 500,
      clock,
    });

    expect(result.healthy).toBe(false);
    expect(result.kind).toBe("tcp");
    expect(result.attempts).toBe(5);
    expect(result.lastError).toMatchObject({
      kind: "connection-refused",
      message: "connection refused",
    });
  });
});

describe("probe app spec", () => {
  it("maps declared probe settings onto the request", async () => {
    const clock = new FakeClock();
    let requested: string | undefined;
    const respondingFetch: ProbeFetch = (url) => {
      requested = url;
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    const result = await probeApp(
      {
        port: 8080,
        probe: "http",
        health_path: "/ready",
        health_interval_ms: 2000,
        health_timeout_ms: 5000,
        health_startup_ms: 90_000,
      },
      { clock, fetch: respondingFetch },
    );

    expect(requested).toBe("http://127.0.0.1:8080/ready");
    expect(result.healthy).toBe(true);
    expect(result.lastStatus).toBe(204);
    expect(result.attempts).toBe(1);
  });

  it("rejects invalid ports and health paths with a usage error", async () => {
    await expect(probeHealth({ port: 80 })).rejects.toMatchObject({
      exitCode: 1,
      code: PROBE_FAILURE_CODES.INVALID_OPTIONS,
    });

    await expect(probeHealth({ port: 8080, healthPath: "health" })).rejects.toMatchObject({
      exitCode: 1,
      code: PROBE_FAILURE_CODES.INVALID_OPTIONS,
    });
  });
});
