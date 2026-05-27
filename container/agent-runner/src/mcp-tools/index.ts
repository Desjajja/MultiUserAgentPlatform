/**
 * MCP tools barrel — imports each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and append the import here. No central list.
 */
import './core.js';
import './xinjiulong-erp.js';
import './read-image.js';
import './read-file.js';
import './interactive.js';
import './next-image-batch.js';
import './session-state.js';
// Non-core tool modules — temporarily disabled because some upstream LLM
// relays (e.g. d1token) return 502 when MCP tool schema count is high.
// The agent's bread-and-butter is `send_message` (in core) + the Claude
// Code SDK's built-in Bash/Read/Write/Edit, which together cover skill
// loading, ERP REST calls, and reply delivery. Re-enable individual
// modules only when a specific workflow is blocked.
// import './scheduling.js';
// import './interactive.js';
// import './agents.js';
// import './self-mod.js';
// import './erp-gateway.js';
// import './classify-intent.js';
import { startMcpServer } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

startMcpServer().catch((err) => {
  log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
