import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import http from "node:http";
import { openPort } from "./port-pool.mjs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isolatedEnvironment(testRoot, extra = {}) {
  return {
    ...process.env,
    HOME: testRoot,
    CODEX_HOME: path.join(testRoot, "codex"),
    CODEX_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    MODEL_ROUTER_USER_MODELS: path.join(testRoot, "state", "user-models.json"),
    CODEX_ROUTER_SERVICE_PLATFORM: "linux",
    CODEX_ROUTER_LAUNCH_AGENTS_DIR: path.join(testRoot, "LaunchAgents"),
    CODEX_ROUTER_SKIP_LAUNCHCTL: "1",
    KIMI_CODE_HOME: path.join(testRoot, "kimi-code"),
    GROK_AUTH_PATH: path.join(testRoot, "grok", "auth.json"),
    HETZNER_API_KEY: "",
    HETZNER_API_BASE_URL: "",
    ...extra,
  };
}

function runNode(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

function writeHetznerCredential(testRoot, value = "TEST_HETZNER_PERSISTENT_KEY") {
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "hetzner-api-key.secret"), `${value}\n`, { mode: 0o600 });
}

test("both installer frontends pass provider selection to setup, which accepts Hetzner", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "hetzner-installer-test-"));
  try {
    const posix = readFileSync(path.join(root, "install.sh"), "utf8");
    const windows = readFileSync(path.join(root, "install.ps1"), "utf8");
    assert.match(posix, /--providers "\$providers"/);
    assert.match(windows, /\$SetupArguments \+= @\("--providers", \$Providers\)/);

    writeHetznerCredential(testRoot, "TEST_HETZNER_INSTALL_KEY");
    const env = isolatedEnvironment(testRoot);
    const result = runNode(
      ["src/setup.mjs", "--providers", "hetzner", "--selection-only"],
      env,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).providers, ["hetzner"]);
    const selection = JSON.parse(
      readFileSync(path.join(testRoot, "state", "enabled-providers.json"), "utf8"),
    );
    assert.deepEqual(selection.providers, ["hetzner"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("providers enable accepts a configured Hetzner key and points catalog-only users at curation", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "hetzner-enable-test-"));
  try {
    writeHetznerCredential(testRoot);
    writeFileSync(
      path.join(testRoot, "state", "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: [] })}\n`,
      { mode: 0o600 },
    );
    const result = runNode(
      ["src/providers.mjs", "enable", "hetzner"],
      isolatedEnvironment(testRoot),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Hetzner is enabled, but ships no preselected models/);
    assert.match(result.stdout, /curate-models hetzner/);
    const selection = JSON.parse(
      readFileSync(path.join(testRoot, "state", "enabled-providers.json"), "utf8"),
    );
    assert.deepEqual(selection.providers, ["hetzner"]);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("doctor recognizes a persistent Hetzner key and warns when no models are curated", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "hetzner-doctor-test-"));
  try {
    writeHetznerCredential(testRoot);
    writeFileSync(
      path.join(testRoot, "state", "enabled-providers.json"),
      `${JSON.stringify({ version: 1, providers: ["hetzner"] })}\n`,
      { mode: 0o600 },
    );
    const result = runNode(["src/doctor.mjs", "--json"], isolatedEnvironment(testRoot));
    const report = JSON.parse(result.stdout);
    const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
    assert.equal(byName["Hetzner key"].status, "ok");
    assert.match(byName["Hetzner key"].detail, /protected file/);
    assert.equal(byName["Hetzner models"].status, "warn");
    assert.match(byName["Hetzner models"].fix, /curate-models hetzner/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Hetzner public-catalog fixtures drive discovery, deterministic curation, and a LiteLLM route", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "hetzner-curation-test-"));
  try {
    const fixture = path.join(testRoot, "models.json");
    writeFileSync(fixture, JSON.stringify({
      data: [
        { id: "Qwen/Qwen3.6-35B-A3B-FP8", object: "model", context_length: 262144 },
        // A record the catalog sizes in silence: curation falls back rather
        // than inventing a window for it.
        { id: "Qwen3.8-27B", object: "model" },
      ],
    }));
    const env = isolatedEnvironment(testRoot);
    const discovery = runNode(
      ["src/model-discovery.mjs", "hetzner", "--fixture", fixture, "--json"],
      env,
    );
    assert.equal(discovery.status, 0, discovery.stderr);
    const discovered = JSON.parse(discovery.stdout);
    // A fixture comparison is not what the provider serves, so it is answered
    // live and never stored.
    assert.equal(discovered.cached, false);
    assert.equal(discovered.stale, false);
    assert.ok(discovered.fetchedAt);
    assert.deepEqual({ ...discovered, cached: undefined, stale: undefined, fetchedAt: undefined }, {
      provider: "hetzner",
      discovered: ["Qwen/Qwen3.6-35B-A3B-FP8", "Qwen3.8-27B"],
      registered: [],
      unregistered: ["Qwen/Qwen3.6-35B-A3B-FP8", "Qwen3.8-27B"],
      addable: ["Qwen/Qwen3.6-35B-A3B-FP8", "Qwen3.8-27B"],
      blocked: {},
      unavailable: [],
      contextLengths: { "Qwen/Qwen3.6-35B-A3B-FP8": 262144 },
      inputModalities: {},
      modelMetadata: [
        {
          upstreamId: "Qwen/Qwen3.6-35B-A3B-FP8",
          displayName: "Qwen/Qwen3.6-35B-A3B-FP8",
          contextWindow: 262144,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsReasoning: false,
          supportsSearch: false,
          supportsTools: false,
          supportsVision: false,
          userDefined: false,
        },
        {
          upstreamId: "Qwen3.8-27B",
          displayName: "Qwen3.8-27B",
          contextWindow: 131072,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsReasoning: false,
          supportsSearch: false,
          supportsTools: false,
          supportsVision: false,
          userDefined: false,
        },
      ],
      cached: undefined,
      stale: undefined,
      fetchedAt: undefined,
      note: "Discovery never edits the registry. New models must pass the live compatibility test before they are listed in Codex.",
    });

    const curation = runNode([
      "src/curate-models.mjs",
      "hetzner",
      "--fixture",
      fixture,
      "--models",
      "Qwen/Qwen3.6-35B-A3B-FP8",
      "--efforts",
      "high",
      "--no-apply",
    ], env);
    assert.equal(curation.status, 0, curation.stderr);
    const stored = JSON.parse(readFileSync(env.MODEL_ROUTER_USER_MODELS, "utf8"));
    assert.equal(stored.models.length, 1);
    assert.equal(stored.models[0].provider, "hetzner");
    assert.equal(stored.models[0].upstreamModel, "Qwen/Qwen3.6-35B-A3B-FP8");
    assert.equal(stored.models[0].requestProfile, undefined);
    // The catalog said how big this model is, so curation stores that rather
    // than the conservative 131072 guess -- and the compaction threshold
    // Codex reads follows from it (#266).
    assert.equal(stored.models[0].contextWindow, 262144);
    assert.equal(stored.models[0].autoCompact, 222822);
    assert.deepEqual(
      stored.models[0].reasoningLevels.map((level) => level.effort),
      ["high"],
    );

    const route = runNode([
      "-e",
      "const { MODELS } = await import('./src/model-registry.mjs');" +
        "const { renderLiteLlmConfig } = await import('./src/litellm-config.mjs');" +
        "const model = MODELS.find((entry) => entry.provider === 'hetzner');" +
        "process.stdout.write(JSON.stringify({ model, config: renderLiteLlmConfig() }));",
    ], env);
    assert.equal(route.status, 0, route.stderr);
    const rendered = JSON.parse(route.stdout);
    assert.equal(rendered.model.gatewayModel, "hetzner-qwen-qwen3-6-35b-a3b-fp8");
    assert.equal(rendered.model.requestProfile, undefined);
    const blockStart = rendered.config.indexOf(
      'model_name: "hetzner-qwen-qwen3-6-35b-a3b-fp8"',
    );
    assert.ok(blockStart >= 0);
    const nextBlock = rendered.config.indexOf("model_name:", blockStart + 1);
    const block = rendered.config.slice(blockStart, nextBlock === -1 ? undefined : nextBlock);
    assert.match(block, /model: "openai\/hetzner-qwen-qwen3-6-35b-a3b-fp8"/);
    assert.match(block, /api_base: "os\.environ\/CODEX_ROUTER_API_FORWARD_BASE_URL"/);
    assert.match(block, /use_chat_completions_api: true/);
    assert.doesNotMatch(block, /HETZNER_API_KEY/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Hetzner onboarding exposes its catalog and private key prompt; account usage is explicitly unavailable", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "hetzner-onboarding-"));
  try {
    const result = runNode(["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      const { PROVIDERS, MODELS } = await import('./src/model-registry.mjs');
      const { providerOnboardingSnapshot } = await import('./src/provider-onboarding.mjs');
      const { providerAccountUsageSnapshot } = await import('./src/provider-account-usage.mjs');
      const provider = PROVIDERS.get('hetzner');
      assert.equal(provider.baseUrl, 'https://inference.hetzner.com/api/v1');
      assert.equal(MODELS.some(model => model.provider === 'hetzner'), false);
      const row = providerOnboardingSnapshot().providers.find(p => p.id === 'hetzner');
      assert.equal(row.action, 'add-key');
      assert.equal(row.configured, false);
      assert.deepEqual(row.catalogSources, [{ id: 'hetzner', displayName: 'Hetzner', kind: 'models-endpoint' }]);
      const usage = await providerAccountUsageSnapshot({
        providerIds: ['hetzner'],
        fetchImpl: async () => { throw new Error('Unexpected account request'); },
      });
      assert.equal(usage.hetzner.status, 'local-only');
      assert.match(usage.hetzner.message, /account usage is unavailable/);
      assert.deepEqual(usage.hetzner.metrics, []);
    `], isolatedEnvironment(testRoot));
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Hetzner curated chat routes isolate credentials and relay text, streaming tools, and upstream errors", async () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "hetzner-forwarder-"));
  const internalKey = "test-hetzner-internal-key-with-length";
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: request.url, headers: request.headers, body });
    const systemIndexes = body.messages.flatMap((message, index) => message.role === "system" ? [index] : []);
    if (body.model === "Qwen/Qwen3.6-35B-A3B-FP8" &&
        (systemIndexes.length > 1 || systemIndexes.some(index => index !== 0))) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "System message must be at the beginning." } }));
    } else if (body.messages[0].content === "error") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture rejected request", type: "invalid_request_error" } }));
    } else if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_fixture", object: "chat.completion.chunk", model: body.model,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_fixture", type: "function", function: { name: "lookup", arguments: '{"city":"Berlin"}' } }] }, finish_reason: "tool_calls" }],
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl_fixture", object: "chat.completion", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "fixture reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      }));
    }
  });
  let child;
  try {
    await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const port = await openPort();
    const env = isolatedEnvironment(testRoot, {
      MODEL_ROUTER_INTERNAL_KEY: internalKey,
      MODEL_ROUTER_API_PORT: String(port),
      MODEL_ROUTER_QUIET: "1",
      HETZNER_API_KEY: "TEST_HETZNER_ONLY_KEY",
      HETZNER_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}/api/v1`,
      TOGETHER_API_KEY: "TEST_UNRELATED_PROVIDER_KEY",
      OPENROUTER_API_KEY: "TEST_OPENROUTER_ORDER_KEY",
      OPENROUTER_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}/api/v1`,
    });
    const fixture = path.join(testRoot, "catalog.json");
    writeFileSync(fixture, JSON.stringify({ data: [{ id: "Qwen/Qwen3.6-35B-A3B-FP8" }] }));
    const curate = runNode(["src/curate-models.mjs", "hetzner", "--fixture", fixture,
      "--models", "Qwen/Qwen3.6-35B-A3B-FP8", "--no-apply"], env);
    assert.equal(curate.status, 0, curate.stderr);
    const model = JSON.parse(readFileSync(env.MODEL_ROUTER_USER_MODELS, "utf8")).models[0];
    const otherModel = { ...model, slug: "hetzner/Other/model", gatewayModel: "hetzner-other-order-fixture",
      upstreamModel: "Other/model", compHash: "hetzner-other-order-fixture" };
    const otherProvider = { ...model, slug: "openrouter/qwen-order-fixture", gatewayModel: "openrouter-qwen-order-fixture",
      provider: "openrouter", compHash: "openrouter-qwen-order-fixture" };
    writeFileSync(env.MODEL_ROUTER_USER_MODELS, JSON.stringify({ version: 1, models: [model, otherModel, otherProvider] }));
    child = spawn(process.execPath, ["src/api-forwarder.mjs"], {
      cwd: root, env, stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) assert.fail(errors);
      try {
        healthy = (await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${internalKey}` } })).ok;
      } catch {}
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(healthy, errors);
    const send = (content, extra = {}, key = internalKey) => fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "chatgpt-account-id": "private-codex-account" },
      body: JSON.stringify({ model: model.gatewayModel, messages: [{ role: "user", content }], ...extra }),
    });
    const denied = await send("denied", {}, "wrong-key");
    assert.equal(denied.status, 401);
    await denied.text();
    assert.equal(requests.length, 0);
    const reply = await send("hello");
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).choices[0].message.content, "fixture reply");
    const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];
    const stream = await send("lookup", { stream: true, tools, tool_choice: "auto" });
    assert.equal(stream.status, 200);
    const chunks = await stream.text();
    assert.match(chunks, /call_fixture/);
    assert.match(chunks, /Berlin/);
    assert.match(chunks, /\[DONE\]/);
    const failure = await send("error");
    assert.equal(failure.status, 400);
    assert.match(await failure.text(), /fixture rejected request/);
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.url, "/api/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer TEST_HETZNER_ONLY_KEY");
      assert.equal(request.headers["chatgpt-account-id"], undefined);
      assert.equal(request.body.model, "Qwen/Qwen3.6-35B-A3B-FP8");
      assert.doesNotMatch(JSON.stringify(request), /TEST_UNRELATED_PROVIDER_KEY|test-hetzner-internal-key/);
    }
    assert.deepEqual(requests[1].body.tools, tools);

    // Reproduce Codex's repeated/late instructions against a strict local
    // upstream. Tool calls/results and developer/user content must survive.
    const user = { role: "user", content: "Build the guide" };
    const developer = { role: "developer", content: "Keep the assigned scope" };
    const assistant = { role: "assistant", content: "Checking", tool_calls: [
      { id: "call_order", type: "function", function: { name: "lookup", arguments: "{}" } },
    ] };
    const tool = { role: "tool", tool_call_id: "call_order", content: "Fixture evidence" };
    const cases = [
      { input: [{ role: "system", content: "Root" }, { role: "system", content: "Worker" }, user],
        expected: [{ role: "system", content: "Root\n\nWorker" }, user] },
      { input: [user, { role: "system", content: "Worker" }, assistant, tool],
        expected: [{ role: "system", content: "Worker" }, user, assistant, tool] },
      { input: [developer, user, { role: "system", content: "Worker" }],
        expected: [{ role: "system", content: "Worker" }, developer, user] },
      { input: [{ role: "system", content: "Root" }, user,
          { role: "system", content: [{ type: "text", text: "Worker" }] }],
        expected: [{ role: "system", content: [{ type: "text", text: "Root" }, { type: "text", text: "Worker" }] }, user] },
      { input: [{ role: "system", content: "Root" }, user],
        expected: [{ role: "system", content: "Root" }, user] },
      { input: [developer, user], expected: [developer, user] },
      { input: [developer, { role: "system", content: "Only system" }, user],
        expected: [{ role: "system", content: "Only system" }, developer, user] },
      { input: [{ role: "system", content: "" }, user, { role: "system", content: "Worker" }],
        expected: [{ role: "system", content: "Worker" }, user], stream: true },
    ];
    for (const { input, expected, stream = false } of cases) {
      const result = await send("unused", { messages: input, tools, stream });
      assert.equal(result.status, 200, await result.text());
      assert.deepEqual(requests.at(-1).body.messages, expected);
      assert.deepEqual(requests.at(-1).body.tools, tools);
    }
    // Neither a different Hetzner model nor the same Qwen upstream model
    // under another provider receives this compatibility rewrite.
    for (const [control, status] of [[otherModel, 200], [otherProvider, 400]]) {
      const messages = [user, { role: "system", content: "Keep this order" }];
      const result = await send("unused", { model: control.gatewayModel, messages });
      assert.equal(result.status, status, await result.text());
      assert.deepEqual(requests.at(-1).body.messages, messages);
    }


  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("exit", resolve));
    }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    rmSync(testRoot, { recursive: true, force: true });
  }
});
