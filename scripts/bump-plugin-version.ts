import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [pluginName, version] = Bun.argv.slice(2);

if (!pluginName || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pluginName)) {
  throw new Error("plugin name must be a directory name under plugins/");
}
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("version must be semver, for example 0.0.2");
}

const pluginDir = resolve(import.meta.dir, "..", "plugins", pluginName);
const packageJsonPath = join(pluginDir, "package.json");
const manifestPath = join(pluginDir, ".baton-plugin", "plugin.json");
const entryPath = join(pluginDir, "src", "index.ts");
const readmePath = join(pluginDir, "README.md");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  version: string;
};
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  version: string;
};
const entry = readFileSync(entryPath, "utf8");
const readme = readFileSync(readmePath, "utf8");

const nextEntry = entry.replace(
  /(\bversion:\s*")[^"]+(")/,
  `$1${version}$2`,
);
const nextReadme = readme.replace(
  /(^version:\s+)\S+/m,
  `$1${version}`,
);
if (nextEntry === entry && !entry.includes(`version: "${version}"`)) {
  throw new Error(`could not find runtime version in ${entryPath}`);
}
if (nextReadme === readme && !readme.includes(`version:  ${version}`)) {
  throw new Error(`could not find documented version in ${readmePath}`);
}

packageJson.version = version;
manifest.version = version;

writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(entryPath, nextEntry);
writeFileSync(readmePath, nextReadme);

console.log(`Bumped ${pluginName} to ${version}`);
