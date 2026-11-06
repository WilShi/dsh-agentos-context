import assert from "node:assert/strict";
import test from "node:test";
import { listConfiguredModels } from "../src/verify-key.ts";

test("model discovery always carries the locked credential and gateway metadata", async () => {
  const config = {
    apiKeyEnv: "CUSTOM_EMBEDDING_KEY",
    distillModel: "",
    embeddingBaseUrl: "https://gateway.example.test/v1",
  };
  const missing = await listConfiguredModels(
    { resolve: async () => undefined },
    config,
    {
      listChatModels: async () => {
        throw new Error("must not list without a credential");
      },
      resolveChatModel: async () => {
        throw new Error("must not resolve without a credential");
      },
    },
  );
  assert.deepEqual(missing, {
    keyConfigured: false,
    models: [],
    auto: null,
    configured: null,
    apiKeyEnv: "CUSTOM_EMBEDDING_KEY",
    embeddingBaseUrl: "https://gateway.example.test/v1",
  });

  const available = await listConfiguredModels(
    { resolve: async () => ({ value: "configured" }) },
    config,
    {
      listChatModels: async () => ["model-a"],
      resolveChatModel: async () => "model-a",
    },
  );
  assert.deepEqual(available, {
    keyConfigured: true,
    models: ["model-a"],
    auto: "model-a",
    configured: null,
    apiKeyEnv: "CUSTOM_EMBEDDING_KEY",
    embeddingBaseUrl: "https://gateway.example.test/v1",
  });
});
