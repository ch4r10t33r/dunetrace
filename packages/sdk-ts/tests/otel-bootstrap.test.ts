/**
 * Tests for src/otel.ts, the env-driven OTel export bootstrap.
 *
 * Mirrors the Python SDK's tests for dunetrace/otel.py: config parsing never
 * throws, a missing endpoint or a disabled flag yields no provider, init is
 * idempotent, the circuit breaker opens and closes on an injectable clock, and
 * a client built with export enabled stamps runs and emits spans without the
 * caller wiring an exporter.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import * as otel from "../src/otel.js";
import * as otelIntegration from "../src/integrations/otel.js";
import { Dunetrace } from "../src/client.js";
import { NoopBatchEmitter } from "../src/emitters.js";

const ENV_KEYS = [
  "DUNETRACE_OTEL_ENABLED",
  "DUNETRACE_OTEL_ENDPOINT",
  "DUNETRACE_OTEL_HEADERS",
  "DUNETRACE_OTEL_PROTOCOL",
  "DUNETRACE_OTEL_SERVICE_NAME",
  "DUNETRACE_OTEL_SAMPLING_RATIO",
  "DUNETRACE_OTEL_CAPTURE_CONTENT",
  "DUNETRACE_ORG_ID",
];

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Under vitest the src tree has no compiled integrations/otel.js to require,
  // so hand the bootstrap the module directly. Production loads it on demand.
  otel._resetForTests(otelIntegration);
});

afterEach(async () => {
  await otel.shutdown();
  otel._resetForTests();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function enabledConfig(overrides: Partial<otel.OtelConfig> = {}): otel.OtelConfig {
  return otel.configFromEnv({ enabled: true, endpoint: "http://collector:4318/v1/traces", ...overrides }, {});
}

// ── Config ───────────────────────────────────────────────────────────────────

describe("configFromEnv", () => {
  it("is disabled with defaults when nothing is set", () => {
    const cfg = otel.configFromEnv({}, {});
    expect(cfg.enabled).toBe(false);
    expect(cfg.endpoint).toBe("");
    expect(cfg.protocol).toBe("grpc");
    expect(cfg.serviceName).toBe("dunetrace");
    expect(cfg.samplingRatio).toBe(1.0);
    expect(cfg.captureContent).toBe(true);
    expect(cfg.headers).toEqual({});
    expect(cfg.serviceVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("reads every DUNETRACE_OTEL_* variable", () => {
    const cfg = otel.configFromEnv({}, {
      DUNETRACE_OTEL_ENABLED: "true",
      DUNETRACE_OTEL_ENDPOINT: " http://localhost:4318/v1/traces ",
      DUNETRACE_OTEL_HEADERS: "DD-API-KEY=abc, x-team = infra ,broken,=novalue",
      DUNETRACE_OTEL_PROTOCOL: "HTTP/protobuf",
      DUNETRACE_OTEL_SERVICE_NAME: "billing-agent",
      DUNETRACE_OTEL_SAMPLING_RATIO: "0.25",
      DUNETRACE_OTEL_CAPTURE_CONTENT: "0",
      DUNETRACE_ORG_ID: "org-1",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.endpoint).toBe("http://localhost:4318/v1/traces");
    expect(cfg.headers).toEqual({ "DD-API-KEY": "abc", "x-team": "infra" });
    expect(cfg.protocol).toBe("http/protobuf");
    expect(cfg.serviceName).toBe("billing-agent");
    expect(cfg.samplingRatio).toBe(0.25);
    expect(cfg.captureContent).toBe(false);
    expect(cfg.orgId).toBe("org-1");
  });

  it("falls back instead of throwing on bad values", () => {
    const cfg = otel.configFromEnv({}, {
      DUNETRACE_OTEL_PROTOCOL: "thrift",
      DUNETRACE_OTEL_SAMPLING_RATIO: "lots",
      DUNETRACE_OTEL_SERVICE_NAME: "   ",
    });
    expect(cfg.protocol).toBe("grpc");
    expect(cfg.samplingRatio).toBe(1.0);
    expect(cfg.serviceName).toBe("dunetrace");
    expect(otel.parseRatio("7")).toBe(1.0);
    expect(otel.parseRatio("-1")).toBe(0.0);
  });

  it("lets overrides win over the environment", () => {
    const cfg = otel.configFromEnv({ enabled: true, samplingRatio: 0.5 }, { DUNETRACE_OTEL_ENABLED: "0" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.samplingRatio).toBe(0.5);
  });

  it("pins the export result codes it spells out to @opentelemetry/core", () => {
    // otel.ts avoids importing core at load time and hardcodes the codes; if
    // the enum ever changes, the breaker would misread results.
    expect(ExportResultCode.SUCCESS).toBe(0);
    expect(ExportResultCode.FAILED).toBe(1);
    const breaker = new otel.CircuitBreakerExporter(
      new ScriptedExporter(() => ({ code: ExportResultCode.SUCCESS })),
    );
    expect(attempt(breaker).code).toBe(ExportResultCode.SUCCESS);
  });
});

// ── Provider ─────────────────────────────────────────────────────────────────

describe("buildTracerProvider / init", () => {
  it("returns null when disabled", () => {
    expect(otel.buildTracerProvider(otel.configFromEnv({}, {}))).toBeNull();
    expect(otel.init(otel.configFromEnv({}, {}))).toBe(false);
    expect(otel.isEnabled()).toBe(false);
    expect(otel.getTracer()).toBeNull();
  });

  it("returns null when enabled without an endpoint", () => {
    expect(otel.buildTracerProvider(otel.configFromEnv({ enabled: true }, {}))).toBeNull();
  });

  it("builds a provider with a real OTLP exporter for each protocol", () => {
    for (const protocol of ["http/protobuf", "grpc"] as const) {
      const provider = otel.buildTracerProvider(enabledConfig({ protocol, headers: { "x-key": "v" } }));
      expect(provider, protocol).not.toBeNull();
      // Nothing was exported, so shutting down must not try the network.
      void provider!.shutdown();
    }
  });

  it("degrades to null when the exporter cannot be built", () => {
    const provider = otel.buildTracerProvider(enabledConfig(), {
      exporterFactory: () => { throw new Error("no exporter for you"); },
    });
    expect(provider).toBeNull();
  });

  it("init is idempotent and the first provider wins", () => {
    const memory = new InMemorySpanExporter();
    expect(otel.init(enabledConfig(), { exporterFactory: () => memory })).toBe(true);
    const first = otel.getTracerProvider();
    expect(otel.init(enabledConfig({ serviceName: "other" }), { exporterFactory: () => new InMemorySpanExporter() })).toBe(true);
    expect(otel.getTracerProvider()).toBe(first);
    expect(otel.activeConfig()!.serviceName).toBe("dunetrace");
    expect(otel.isEnabled()).toBe(true);
  });

  it("stamps service, version, and org on the resource and honours the sampling ratio", async () => {
    const memory = new InMemorySpanExporter();
    otel.init(enabledConfig({ orgId: "org-9", serviceName: "svc", samplingRatio: 0 }), { exporterFactory: () => memory });
    const attrs = otel.getTracerProvider()!.resource.attributes;
    expect(attrs["service.name"]).toBe("svc");
    expect(attrs["dunetrace.org_id"]).toBe("org-9");
    expect(String(attrs["service.version"])).toMatch(/^\d+\.\d+\.\d+/);

    // Ratio 0 means every root span is sampled out and never reaches the exporter.
    otel.getTracer()!.startSpan("dropped").end();
    await otel.forceFlush();
    expect(memory.getFinishedSpans()).toHaveLength(0);
  });

  it("forceFlush delivers queued spans; shutdown clears state and is safe to repeat", async () => {
    const memory = new InMemorySpanExporter();
    otel.init(enabledConfig(), { exporterFactory: () => memory });
    otel.getTracer()!.startSpan("kept").end();
    expect(memory.getFinishedSpans()).toHaveLength(0); // still in the batch queue
    await otel.forceFlush();
    expect(memory.getFinishedSpans().map((s) => s.name)).toEqual(["kept"]);
    // InMemorySpanExporter.shutdown() resets its buffer, so assert state only.
    await otel.shutdown();
    expect(otel.isEnabled()).toBe(false);
    expect(otel.activeConfig()).toBeNull();
    await expect(otel.shutdown()).resolves.toBeUndefined();
    await expect(otel.forceFlush()).resolves.toBeUndefined();
  });
});

// ── Circuit breaker ──────────────────────────────────────────────────────────

class ScriptedExporter implements SpanExporter {
  calls = 0;
  constructor(private readonly outcome: () => ExportResult | Error) {}
  export(_spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
    this.calls += 1;
    const o = this.outcome();
    if (o instanceof Error) throw o;
    cb(o);
  }
  shutdown(): Promise<void> { return Promise.resolve(); }
  forceFlush(): Promise<void> { return Promise.resolve(); }
}

function attempt(breaker: otel.CircuitBreakerExporter): ExportResult {
  let seen: ExportResult | null = null;
  breaker.export([], (r) => { seen = r; });
  return seen!;
}

describe("CircuitBreakerExporter", () => {
  let clock = 0;
  const now = () => clock;
  beforeEach(() => { clock = 1_000_000; });

  it("opens after the failure threshold and stops calling the exporter", () => {
    const inner = new ScriptedExporter(() => ({ code: ExportResultCode.FAILED, error: new Error("refused") }));
    const breaker = new otel.CircuitBreakerExporter(inner, now);
    for (let i = 0; i < otel.CircuitBreakerExporter.FAILURE_THRESHOLD; i++) {
      clock += 1000;
      expect(attempt(breaker).code).toBe(ExportResultCode.FAILED);
    }
    expect(breaker.isOpen()).toBe(true);
    const callsAtTrip = inner.calls;
    clock += 1000;
    expect(attempt(breaker).code).toBe(ExportResultCode.FAILED);
    expect(inner.calls).toBe(callsAtTrip); // dropped without touching the exporter
  });

  it("retries after the cooldown and closes on the first success", () => {
    let fail = true;
    const inner = new ScriptedExporter(() => (fail ? new Error("boom") : { code: ExportResultCode.SUCCESS }));
    const breaker = new otel.CircuitBreakerExporter(inner, now);
    for (let i = 0; i < otel.CircuitBreakerExporter.FAILURE_THRESHOLD; i++) attempt(breaker);
    expect(breaker.isOpen()).toBe(true);

    clock += otel.CircuitBreakerExporter.COOLDOWN_MS + 1;
    fail = false;
    expect(breaker.isOpen()).toBe(false);
    expect(attempt(breaker).code).toBe(ExportResultCode.SUCCESS);
    // Failures were cleared on success: a single new failure must not trip it.
    fail = true;
    attempt(breaker);
    expect(breaker.isOpen()).toBe(false);
  });

  it("only counts failures inside the window", () => {
    const inner = new ScriptedExporter(() => ({ code: ExportResultCode.FAILED }));
    const breaker = new otel.CircuitBreakerExporter(inner, now);
    for (let i = 0; i < otel.CircuitBreakerExporter.FAILURE_THRESHOLD - 1; i++) attempt(breaker);
    clock += otel.CircuitBreakerExporter.WINDOW_MS + 1; // the earlier failures age out
    attempt(breaker);
    expect(breaker.isOpen()).toBe(false);
  });

  it("turns a throwing exporter into a FAILED result instead of propagating", () => {
    const inner = new ScriptedExporter(() => new Error("exporter bug"));
    const breaker = new otel.CircuitBreakerExporter(inner, now);
    const result = attempt(breaker);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error?.message).toBe("exporter bug");
  });
});

// ── Client wiring ────────────────────────────────────────────────────────────

describe("Dunetrace client auto-wiring", () => {
  it("leaves runs unstamped and emits no spans when OTel is off", async () => {
    const dt = new Dunetrace({ emitter: new NoopBatchEmitter(), flushOnExit: false });
    await dt.run("agent", { model: "gpt-4o" }, async (run) => {
      expect(run.otelTraceId).toBeNull();
      expect(run.otelSpanId).toBeNull();
    });
    await dt.shutdown();
  });

  it("builds the exporter from env and emits spans on the shared tracer", async () => {
    const memory = new InMemorySpanExporter();
    process.env.DUNETRACE_OTEL_ENABLED = "1";
    process.env.DUNETRACE_OTEL_ENDPOINT = "http://collector:4318/v1/traces";
    process.env.DUNETRACE_OTEL_CAPTURE_CONTENT = "false";
    // Same env-driven path the client takes, with the network exporter swapped out.
    expect(otel.init(undefined, { exporterFactory: () => memory })).toBe(true);

    const dt = new Dunetrace({ emitter: new NoopBatchEmitter(), flushOnExit: false });
    let runId = "";
    await dt.run("billing-agent", { model: "gpt-4o" }, async (run) => {
      runId = run.runId;
      expect(run.otelTraceId).toBe(runId.replace(/-/g, ""));
      expect(run.otelSpanId).toBe(run.otelTraceId!.slice(16));
      run.toolCalled("lookup", { url: "https://crm.internal/acct/42" });
      run.toolResponded("lookup", true, 12, 8);
      run.finalAnswer();
    });
    await dt.shutdown(); // flushes the batch processor too

    const spans = memory.getFinishedSpans();
    const names = spans.map((s) => s.name).sort();
    expect(names).toEqual(["dunetrace.run", "dunetrace.tool.lookup"]);
    const root = spans.find((s) => s.name === "dunetrace.run")!;
    expect(root.spanContext().traceId).toBe(runId.replace(/-/g, ""));
    // captureContent=false came through from env: no URL on the tool span.
    const tool = spans.find((s) => s.name === "dunetrace.tool.lookup")!;
    expect(tool.attributes["url.full"]).toBeUndefined();
    expect(tool.attributes["server.address"]).toBe("crm.internal");
  });

  it("the exit flush pushes queued spans once and then stays quiet", async () => {
    const memory = new InMemorySpanExporter();
    process.env.DUNETRACE_OTEL_ENABLED = "1";
    process.env.DUNETRACE_OTEL_ENDPOINT = "http://collector:4318/v1/traces";
    otel.init(undefined, { exporterFactory: () => memory });

    const dt = new Dunetrace({ emitter: new NoopBatchEmitter(), flushOnExit: false });
    await dt.run("agent", { model: "gpt-4o" }, async (run) => { run.finalAnswer(); });
    expect(memory.getFinishedSpans()).toHaveLength(0); // sitting in the batch queue

    // First beforeExit pass: flushes the OTel queue.
    dt._flushBeforeExit();
    await otel.forceFlush(); // settle the in-flight flush
    expect(memory.getFinishedSpans().map((s) => s.name)).toEqual(["dunetrace.run"]);

    // Later passes must schedule nothing, or Node would never exit. The only
    // observable is that a second call returns without touching the exporter:
    // a new span left in the queue stays there.
    otel.getTracer()!.startSpan("after-exit").end();
    dt._flushBeforeExit();
    await new Promise((r) => setTimeout(r, 20));
    expect(memory.getFinishedSpans().map((s) => s.name)).toEqual(["dunetrace.run"]);
    await dt.shutdown();
  });

  it("an explicit exporter option wins over the env bootstrap", async () => {
    const memory = new InMemorySpanExporter();
    process.env.DUNETRACE_OTEL_ENABLED = "1";
    process.env.DUNETRACE_OTEL_ENDPOINT = "http://collector:4318/v1/traces";
    otel.init(undefined, { exporterFactory: () => memory });

    const handled: string[] = [];
    const dt = new Dunetrace({
      emitter: new NoopBatchEmitter(),
      flushOnExit: false,
      exporter: { handle: (e) => { handled.push(e.event_type); } },
    });
    await dt.run("agent", { model: "gpt-4o" }, async (run) => { run.finalAnswer(); });
    await dt.shutdown();
    expect(handled).toEqual(["run.started", "run.completed"]);
    expect(memory.getFinishedSpans()).toHaveLength(0);
  });
});
