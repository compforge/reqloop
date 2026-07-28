import { describe, expect, test } from "bun:test";

import { replaceRuntimeVersion } from "./bump-plugin-version.ts";

describe("replaceRuntimeVersion", () => {
  test("updates an exported package version constant", () => {
    expect(replaceRuntimeVersion(
      'export const REQLOOP_PACKAGE_VERSION = "0.1.13";\n',
      "0.1.14",
    )).toBe(
      'export const REQLOOP_PACKAGE_VERSION = "0.1.14";\n',
    );
  });

  test("updates an inline PluginPackage version", () => {
    expect(replaceRuntimeVersion(
      'const plugin = { version: "0.0.1" };\n',
      "0.0.2",
    )).toBe(
      'const plugin = { version: "0.0.2" };\n',
    );
  });

  test("rejects entries without a runtime version declaration", () => {
    expect(() => replaceRuntimeVersion(
      "export default {};\n",
      "0.0.2",
    )).toThrow("runtime version declaration not found");
  });
});
