import { describe, expect, it } from "@effect/vitest";

import {
  freshConfig,
  isAllowedManagementPath,
  proxyCustomModels,
  readProxyConfig,
  releaseAssetName,
} from "./CliProxy.ts";

describe("CLIProxyAPI config", () => {
  it("reads where it listens and its client key from the v7 and v8 layouts", () => {
    expect(readProxyConfig("host: ''\nport: 9000\napi-keys:\n  - sk-one\n  - sk-two\n")).toEqual({
      host: "127.0.0.1",
      port: 9000,
      clientKey: "sk-one",
    });
    expect(
      readProxyConfig(
        "server:\n  host: 127.0.0.1\n  port: 8400\naccess:\n  api-keys: [sk-v8]\napi-keys:\n  codex: []\n",
      ),
    ).toEqual({ host: "127.0.0.1", port: 8400, clientKey: "sk-v8" });
    expect(readProxyConfig("")).toEqual({ host: "127.0.0.1", port: 8317, clientKey: null });
  });

  it("writes a fresh config that reads back with its client key", () => {
    const text = freshConfig({
      port: 8318,
      authDir: "/x/auth",
      clientKey: "sk-t3-a",
      managementKey: "t3-b",
    });
    expect(readProxyConfig(text)).toEqual({ host: "127.0.0.1", port: 8318, clientKey: "sk-t3-a" });
    expect(text).toContain("secret-key: t3-b");
  });
});

describe("management passthrough", () => {
  it("allows only management and model-list paths", () => {
    expect(isAllowedManagementPath("/v8/management/config")).toBe(true);
    expect(isAllowedManagementPath("/v8/management/oauth/auth-url?provider=claude")).toBe(true);
    expect(isAllowedManagementPath("/v0/management/codex-auth-url")).toBe(true);
    expect(isAllowedManagementPath("/v1/models")).toBe(true);
    expect(isAllowedManagementPath("/v1/messages")).toBe(false);
    expect(isAllowedManagementPath("/v8/management/../../v1/messages")).toBe(false);
    expect(isAllowedManagementPath("/v8/management/%2e%2e/x")).toBe(false);
    expect(isAllowedManagementPath("/v8/managementx")).toBe(false);
  });
});

describe("releases", () => {
  it("names this system's release asset, or none where there is no build", () => {
    expect(releaseAssetName("v8.0.4", "win32", "x64")).toBe("CLIProxyAPI_8.0.4_windows_amd64.zip");
    expect(releaseAssetName("8.0.4", "darwin", "arm64")).toBe(
      "CLIProxyAPI_8.0.4_darwin_aarch64.tar.gz",
    );
    expect(releaseAssetName("8.0.4", "linux", "x64")).toBe("CLIProxyAPI_8.0.4_linux_amd64.tar.gz");
    expect(releaseAssetName("8.0.4", "aix", "x64")).toBeNull();
    expect(releaseAssetName("8.0.4", "linux", "ia32")).toBeNull();
  });
});

describe("the CLIProxyAPI provider's models", () => {
  it("lists other providers' models and each pool once, under the pool's name", () => {
    const config = {
      "api-keys": {
        "openai-compatibility": [
          {
            "base-url": "http://127.0.0.1:8317/v1",
            models: [
              { name: "gpt-6-luna", alias: "luna-then-muse", "display-name": "Luna, else Muse" },
            ],
          },
          {
            "base-url": "http://127.0.0.1:8317/v1",
            models: [{ name: "muse", alias: "luna-then-muse" }],
          },
          {
            "base-url": "http://127.0.0.1:8317/v1",
            models: [{ name: "claude-sonnet-5", alias: "sonnet-then-luna" }],
          },
        ],
      },
    };
    const models = {
      data: [
        { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", owned_by: "anthropic" },
        { id: "claude-fable-5-dd-anul-6-tpg", display_name: "GPT 6.0 Luna", owned_by: "openai" },
        { id: "claude-fable-5-dd-2-egami-tpg", display_name: "GPT Image 2", owned_by: "openai" },
        {
          id: "claude-fable-5-dd-esum-neht-anul",
          display_name: "luna-then-muse",
          owned_by: "pool",
        },
      ],
    };
    expect(proxyCustomModels(models, config)).toEqual([
      { slug: "claude-fable-5-dd-anul-6-tpg", name: "GPT 6.0 Luna" },
      { slug: "claude-fable-5-dd-esum-neht-anul", name: "Luna, else Muse" },
      { slug: "sonnet-then-luna", name: "sonnet-then-luna" },
    ]);
  });
});
