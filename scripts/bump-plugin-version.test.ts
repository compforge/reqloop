import { describe, expect, test } from "bun:test";

import {
  replacePackageVersion,
  replaceReleaseVersion,
} from "./bump-plugin-version.ts";

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

describe("replaceReleaseVersion", () => {
  test("updates the current version without rewriting release notes", () => {
    expect(replaceReleaseVersion(
      "# Releases\n\nCurrent version: `0.1.13`\n\n## 0.1.13\n\n- Notes.\n",
      "0.1.14",
    )).toBe(
      "# Releases\n\nCurrent version: `0.1.14`\n\n## 0.1.13\n\n- Notes.\n",
    );
  });

  test("rejects release files without a current version", () => {
    expect(() => replaceReleaseVersion(
      "# Releases\n",
      "0.1.14",
    )).toThrow("Current release version not found");
  });
});
