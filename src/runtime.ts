import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

const { setRuntime: setSuiteRuntime, getRuntime: getSuiteRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Burrow runtime not initialized");

export { getSuiteRuntime, setSuiteRuntime };
