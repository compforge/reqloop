import type { PluginContext, PluginPackage } from "@compforge/baton-plugin";

const hello: PluginPackage = Object.freeze({
  pluginId: "compforge/hello",
  version: "0.1.0",
  async activate(_context: PluginContext): Promise<void> {},
});

export default hello;
