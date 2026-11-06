/** Real Loader composition for the shipped Host plugin row. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Include from "@deepseek-ai/cordis-plugin-include";
import Settings from "@deepseek-ai/dsh-settings";
import * as AgentosContext from "../src/index.ts";

async function eventually(read, accept, label) {
  const deadline = Date.now() + 5000;
  do {
    const value = read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${label}`);
}

test("real Loader composition mounts the memory capability and disposes its tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-agentos-context-loader-"));
  const configPath = join(root, "cordis.yml");
  const dbPath = join(root, "context.db");
  const tools = [];
  const routes = [];
  const commands = [];
  const context = new Context();
  let entry;
  const inherited = {
    contextDbPath: dbPath,
    capturePrompts: false,
    enableInsights: false,
    enableKnowledge: false,
    autoSummarize: false,
    captureToolResults: false,
  };
  let override = {};
  try {
    await writeFile(
      configPath,
      [
        "- id: dsh-opencontext",
        "  name: '@wilshi/dsh-agentos-context'",
        "  config:",
        `    contextDbPath: ${JSON.stringify(dbPath)}`,
        "    capturePrompts: false",
        "    enableInsights: false",
        "    enableKnowledge: false",
        "    autoSummarize: false",
        "    captureToolResults: false",
        "",
      ].join("\n"),
    );
    await writeFile(join(root, "settings.yaml"), "dsh-opencontext:\n  capturePrompts: true\n");

    context.provide("tools", {
      register(tool) {
        tools.push(tool);
        return () => {
          const index = tools.indexOf(tool);
          if (index >= 0) tools.splice(index, 1);
        };
      },
    });
    context.provide("agents", {});
    context.provide("agentDefaultModel", {});
    context.provide("systemPrompt", {});
    context.provide("commands", {
      register(command) {
        commands.push(command);
        return () => {
          const index = commands.indexOf(command);
          if (index >= 0) commands.splice(index, 1);
        };
      },
    });
    context.provide("llm", {});
    context.provide("sessions", { get: () => undefined });
    context.provide("credentials", {
      resolve: async () => undefined,
      describe: async () => ({ configured: false }),
    });
    context.provide("connection", {
      fetch: {
        register(route) {
          routes.push(route);
          return async () => {
            const index = routes.indexOf(route);
            if (index >= 0) routes.splice(index, 1);
          };
        },
      },
    });
    context.provide("profileContext", {
      name: "test",
      home: root,
      dir: root,
      patchPath: join(root, "profile.patch.yml"),
    });
    context.provide("configEditor", {
      documentPath: join(root, "profile.patch.yml"),
      entries: () => {
        const current = [...context.loader.entries()].find(
          (candidate) => candidate.options.name === "@wilshi/dsh-agentos-context",
        );
        return current === undefined ? [] : [current];
      },
      configuration() {
        return this.entries().map((current) => ({ entry: current, inherited, override }));
      },
      async edit(target, change) {
        assert.equal(target.options.id, "dsh-opencontext");
        const current = structuredClone(target.options.config ?? {});
        const next = change(current, inherited);
        override = structuredClone(next);
        await target.update({ config: next });
      },
    });

    context.baseUrl = `${pathToFileURL(root).href}/`;
    await context.plugin(Loader);
    context.loader.builtins.include = Include;
    context.loader.internal = {
      version: "v2",
      async import(specifier) {
        if (specifier === "@wilshi/dsh-agentos-context") return AgentosContext;
        throw new Error(`unexpected Loader import: ${specifier}`);
      },
    };
    await context.loader.create({
      name: "cordis:include",
      config: { path: pathToFileURL(configPath).href },
    });
    await context.plugin(Settings);
    await context.loader.await();
    entry = [...context.loader.entries()].find(
      (candidate) => candidate.options.name === "@wilshi/dsh-agentos-context",
    );
    assert.ok(entry?.fiber);
    await entry.fiber.await();
    assert.equal(entry.options.id, "dsh-opencontext");
    const originalFiber = entry.fiber;
    const initial = await eventually(
      () => context.settings.describe().find((row) => row.ns === "dsh-opencontext"),
      (row) => row?.value.capturePrompts === true && !existsSync(join(root, "settings.yaml")),
      "legacy settings import",
    );
    assert.ok(initial);
    assert.equal(initial.autoGenerate, false);
    assert.equal(initial.value.capturePrompts, true);
    await access(join(root, "settings.yaml.imported"));
    assert.equal(Object.hasOwn(initial.value, "apiKeyEnv"), false);
    assert.equal(Object.hasOwn(initial.value, "embeddingBaseUrl"), false);
    await context.settings.mutate("dsh-opencontext", [
      { op: "set", path: ["capturePrompts"], value: false },
      { op: "set", path: ["workingMemoryHours"], value: 36 },
    ], initial.revision);
    const edited = context.settings.describe().find((row) => row.ns === "dsh-opencontext");
    assert.equal(edited.value.capturePrompts, false);
    assert.equal(edited.value.workingMemoryHours, 36);
    assert.equal(entry.fiber, originalFiber);
    assert.equal(entry.fiber.config.capturePrompts.get(), false);
    assert.equal(tools.some((tool) => tool.name === "memory_search"), true);
    assert.equal(tools.some((tool) => tool.name === "oc_search"), true);
    assert.equal(routes.length, 30);
    assert.deepEqual(
      commands.map((command) => command.name),
      ["memory", "oc"],
    );

    await originalFiber.dispose();
    assert.equal(tools.length, 0);
    assert.equal(commands.length, 0);
  } finally {
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});