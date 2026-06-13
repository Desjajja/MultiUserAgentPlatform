import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { createDestination } from './db/agent-destinations.js';
import { initSessionFolder, openInboundDb } from '../../session-manager.js';
import { writeDestinations } from './write-destinations.js';
import type { Session } from '../../types.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-write-dest' };
});

const TEST_DIR = '/tmp/nanoclaw-test-write-dest';

function now(): string {
  return new Date().toISOString();
}

function readDestinations(agentGroupId: string, sessionId: string) {
  const db = openInboundDb(agentGroupId, sessionId);
  const rows = db
    .prepare('SELECT name, type, channel_type, platform_id FROM destinations ORDER BY rowid')
    .all() as Array<{ name: string; type: string; channel_type: string | null; platform_id: string | null }>;
  db.close();
  return rows;
}

describe('writeDestinations session-scoped channel projection', () => {
  const AG = 'ag-desk';
  let cliSession: Session;
  let feishuSession: Session;

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: AG, name: 'Desk', folder: 'desk', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: 'mg-cli',
      channel_type: 'cli',
      platform_id: 'local',
      name: 'CLI',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-feishu',
      channel_type: 'feishu',
      platform_id: 'feishu:p2p:ou_test',
      name: 'Feishu DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createDestination({
      agent_group_id: AG,
      local_name: 'feishu-dm',
      target_type: 'channel',
      target_id: 'mg-feishu',
      created_at: now(),
    });

    cliSession = {
      id: 'sess-cli',
      agent_group_id: AG,
      messaging_group_id: 'mg-cli',
      thread_id: null,
      owner_user_id: 'cli:user-1',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    };
    feishuSession = {
      id: 'sess-feishu',
      agent_group_id: AG,
      messaging_group_id: 'mg-feishu',
      thread_id: null,
      owner_user_id: 'feishu:ou_test',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    };
    createSession(cliSession);
    createSession(feishuSession);
    initSessionFolder(AG, cliSession.id);
    initSessionFolder(AG, feishuSession.id);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('projects only the CLI ingress channel for a CLI session', () => {
    writeDestinations(AG, cliSession.id);
    expect(readDestinations(AG, cliSession.id)).toEqual([
      { name: 'origin', type: 'channel', channel_type: 'cli', platform_id: 'local' },
    ]);
  });

  it('projects the matching Feishu channel for a Feishu session', () => {
    writeDestinations(AG, feishuSession.id);
    expect(readDestinations(AG, feishuSession.id)).toEqual([
      { name: 'feishu-dm', type: 'channel', channel_type: 'feishu', platform_id: 'feishu:p2p:ou_test' },
    ]);
  });
});
