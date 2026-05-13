import { composeGroupClaudeMd } from '../src/claude-md-compose.js';
import { initDb } from "../src/db/connection.js";
import { getAgentGroup } from '../src/db/agent-groups.js';

const workers = [
  'ag-1778660838-knowwk',
  'ag-1778662164-robotwk',
  'ag-1778662219-monwk',
  'ag-1778662245-remotewk',
  'ag-1778662245-labopswk',
  'ag-1778662350-feishubase',
  'ag-1778662351-feishucomm',
  'ag-1778662352-feishudoc',
];

initDb('/Users/realityloop/nanoclaw_lark/MultiUserAgentPlatform/data/v2.db');

for (const id of workers) {
  const ag = getAgentGroup(id);
  if (!ag) {
    console.log(`${id}: NOT FOUND in DB`);
    continue;
  }
  composeGroupClaudeMd(ag);
  console.log(`${ag.folder}: recomposed`);
}
