import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import hello from "../src/index.ts";

interface PluginManifest {
  pluginId: string;
  version: string;
  entry: string;
}

describe("Hello PluginPackage", () => {
  test("keeps its runtime identity aligned with the Package manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../.baton-plugin/plugin.json", import.meta.url), "utf8"),
    ) as PluginManifest;

    expect(hello.pluginId).toBe(manifest.pluginId);
    expect(hello.version).toBe(manifest.version);
    expect(manifest.entry).toBe("./src/index.ts");
    expect(typeof hello.activate).toBe("function");
  });

  test("activates without registering optional capabilities", () => {
    expect(() => hello.activate()).not.toThrow();
  });
});
