import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      lstatSync: vi.fn(() => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        isFile: () => true,
      })),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
      rmSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock agent-skill-sync
vi.mock('./agent-skill-sync.js', () => ({
  syncAgentSkills: vi.fn(),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import fs from 'fs';
import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const mockedFs = vi.mocked(fs);

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

/**
 * Tests for version-based agent-runner sync in buildVolumeMounts.
 *
 * These tests exercise the sync logic indirectly through runContainerAgent,
 * which calls buildVolumeMounts internally. We verify by checking which
 * fs operations were performed.
 */
describe('agent-runner version-based sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.clearAllMocks();

    // Default: most paths don't exist
    mockedFs.existsSync.mockImplementation(() => false);
    (mockedFs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);
    mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper to run container and immediately close it
  async function runAndClose() {
    const promise = runContainerAgent(testGroup, testInput, () => {});
    // Let it start, then close immediately
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: null })}\n${OUTPUT_END_MARKER}\n`,
    );
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    return promise;
  }

  it('syncs runner when .base-version is missing', async () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('.keep-local-agent-runner')) return false;
      if (s.includes('agent-runner-src')) return true;
      if (s.endsWith(path.join('container', 'agent-runner', 'src')))
        return true;
      return false;
    });
    // .base-version doesn't exist → readFileSync throws ENOENT
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version')) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return '';
    }) as typeof fs.readFileSync);

    await runAndClose();

    // Should have performed rmSync + cpSync + writeFileSync for version
    expect(mockedFs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('agent-runner-src'),
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(mockedFs.cpSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join('container', 'agent-runner', 'src')),
      expect.stringContaining('agent-runner-src'),
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.base-version'),
      expect.stringContaining('evolving-personality-v1'),
    );
  });

  it('syncs runner when .base-version is mismatched', async () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('.keep-local-agent-runner')) return false;
      if (s.includes('agent-runner-src')) return true;
      if (s.endsWith(path.join('container', 'agent-runner', 'src')))
        return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version')) return 'old-version\n';
      return '';
    }) as typeof fs.readFileSync);

    await runAndClose();

    // Version mismatch → should sync
    expect(mockedFs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('agent-runner-src'),
      expect.objectContaining({ recursive: true }),
    );
    expect(mockedFs.cpSync).toHaveBeenCalled();
  });

  it('skips sync when .keep-local-agent-runner exists', async () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('.keep-local-agent-runner')) return true;
      if (s.includes('agent-runner-src')) return true;
      if (s.endsWith(path.join('container', 'agent-runner', 'src')))
        return true;
      return false;
    });

    await runAndClose();

    // Should NOT have synced
    expect(mockedFs.rmSync).not.toHaveBeenCalledWith(
      expect.stringContaining('agent-runner-src'),
      expect.anything(),
    );
    expect(mockedFs.cpSync).not.toHaveBeenCalledWith(
      expect.stringContaining(path.join('container', 'agent-runner', 'src')),
      expect.anything(),
      expect.anything(),
    );
  });

  it('handles unreadable .base-version by forcing sync', async () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('.keep-local-agent-runner')) return false;
      if (s.includes('agent-runner-src')) return true;
      if (s.endsWith(path.join('container', 'agent-runner', 'src')))
        return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version')) throw new Error('EACCES');
      return '';
    }) as typeof fs.readFileSync);

    await runAndClose();

    // Unreadable version → currentVersion is null → shouldSync is true
    expect(mockedFs.cpSync).toHaveBeenCalled();
  });

  it('skips sync when .base-version matches current version', async () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('.keep-local-agent-runner')) return false;
      if (s.includes('agent-runner-src')) return true;
      if (s.endsWith(path.join('container', 'agent-runner', 'src')))
        return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version'))
        return 'evolving-personality-v1\n';
      return '';
    }) as typeof fs.readFileSync);

    await runAndClose();

    // Version matches → should NOT have synced
    expect(mockedFs.rmSync).not.toHaveBeenCalledWith(
      expect.stringContaining('agent-runner-src'),
      expect.anything(),
    );
    expect(mockedFs.cpSync).not.toHaveBeenCalledWith(
      expect.stringContaining(path.join('container', 'agent-runner', 'src')),
      expect.anything(),
      expect.anything(),
    );
  });

  it('full refresh removes stale files before copy', async () => {
    const callOrder: string[] = [];
    mockedFs.rmSync.mockImplementation(() => {
      callOrder.push('rmSync');
    });
    mockedFs.mkdirSync.mockImplementation(() => {
      callOrder.push('mkdirSync');
      return undefined;
    });
    mockedFs.cpSync.mockImplementation(() => {
      callOrder.push('cpSync');
    });

    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('.keep-local-agent-runner')) return false;
      if (s.includes('agent-runner-src')) return true;
      if (s.endsWith(path.join('container', 'agent-runner', 'src')))
        return true;
      return false;
    });
    // No .base-version file → ENOENT triggers sync
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version')) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return '';
    }) as typeof fs.readFileSync);

    await runAndClose();

    // rmSync should happen before cpSync for the agent-runner-src directory
    const rmIdx = callOrder.indexOf('rmSync');
    const cpIdx = callOrder.indexOf('cpSync');
    expect(rmIdx).toBeGreaterThan(-1);
    expect(cpIdx).toBeGreaterThan(-1);
    expect(rmIdx).toBeLessThan(cpIdx);
  });
});
