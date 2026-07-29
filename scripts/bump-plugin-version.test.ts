import { describe, expect, test } from "bun:test";

import { replacePackageVersion } from "./bump-plugin-version.ts";

describe("replacePackageVersion", () => {
  test("updates an exported package version constant", () => {
    expect(replacePackageVersion(
      'export const REQLOOP_PACKAGE_VERSION = "0.1.13";\n',
      "0.1.14",
    )).toBe(
      'export const REQLOOP_PACKAGE_VERSION = "0.1.14";\n',
    );
  });

  test("updates an inline PluginPackage version", () => {
    expect(replacePackageVersion(
      'const plugin = { version: "0.0.1" };\n',
      "0.0.2",
    )).toBe(
      'const plugin = { version: "0.0.2" };\n',
    );
  });

  test("rejects entries without a Package version declaration", () => {
    expect(() => replacePackageVersion(
      "export default {};\n",
      "0.0.2",
    )).toThrow("Package version declaration not found");
  });
});
