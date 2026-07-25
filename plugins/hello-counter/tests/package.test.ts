import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import helloCounter from "../src/index.ts";

interface PluginManifest {
  pluginId: string;
  version: string;
  entry: string;
}

describe("Hello Counter PluginPackage", () => {
  test("keeps its runtime identity aligned with the Package manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../.baton-plugin/plugin.json", import.meta.url), "utf8"),
    ) as PluginManifest;

    expect(helloCounter.pluginId).toBe(manifest.pluginId);
    expect(helloCounter.version).toBe(manifest.version);
    expect(manifest.entry).toBe("./src/index.ts");
    expect(typeof helloCounter.activate).toBe("function");
  });
});
