import { t3PiMcpExtension } from "./PiMcpBridgeExtension.ts";

export const PI_MCP_ENDPOINT_ENV = "T3_PI_MCP_ENDPOINT";
export const PI_MCP_AUTHORIZATION_ENV = "T3_PI_MCP_AUTHORIZATION";
export const PI_MCP_SCOPE_ENV = "T3_PI_MCP_SCOPE";

// Pi loads extensions from files, so the typed bridge function is written out as an ES module.
// Serializing the function itself keeps one checked implementation for Pi, the server bundle,
// and tests; t3PiMcpExtension documents why it must stay self-contained.
export const PI_MCP_EXTENSION_SOURCE = `export default ${t3PiMcpExtension.toString()}\n`;
