import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import hello from "../src/index.ts";

interface PluginManifest {
  pluginId: string;
  version: string;
  entry: string;
}

describe("Hello PluginPackage", () => {
  test("keeps its Package identity aligned with the manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../.baton-plugin/plugin.json", import.meta.url), "utf8"),
    ) as PluginManifest;

    expect(manifest.pluginId).toBe(hello.pluginId);
    expect(manifest.version).toBe(hello.version);
    expect(manifest.entry).toBe("./src/index.ts");
    expect(typeof hello.activate).toBe("function");
  });

  test("activates without registering optional capabilities", async () => {
    await expect(hello.activate()).resolves.toBeUndefined();
  });
});
