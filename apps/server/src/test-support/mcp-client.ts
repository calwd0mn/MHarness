/** 供跨包验收测试使用的 MCP SDK 客户端；连接由测试持有并负责关闭。 */
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
/** 供跨包验收测试建立 MCP HTTP 连接；由持有它的客户端或测试负责关闭。 */
export { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
