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

  /**
   * Helper: configure mockedFs.existsSync for common path patterns.
   * Reduces duplication across tests that only differ in which paths exist.
   */
  function mockExistsPaths(opts: {
    keepLocal?: boolean;
    runnerSrc?: boolean;
    agentRunnerDir?: boolean;
  }) {
    const { keepLocal = false, runnerSrc = true, agentRunnerDir = true } = opts;
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('.keep-local-agent-runner')) return keepLocal;
      if (s.includes('agent-runner-src')) return agentRunnerDir;
      if (s.endsWith(path.join('container', 'agent-runner', 'src')))
        return runnerSrc;
      return false;
    });
  }

  it('syncs runner when .base-version is missing', async () => {
    mockExistsPaths({});
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
      expect.stringContaining('2026-02-27'),
    );
  });

  it('syncs runner when .base-version is mismatched', async () => {
    mockExistsPaths({});
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
    mockExistsPaths({ keepLocal: true });

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
    mockExistsPaths({});
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version')) throw new Error('EACCES');
      return '';
    }) as typeof fs.readFileSync);

    await runAndClose();

    // Unreadable version → currentVersion is null → shouldSync is true
    expect(mockedFs.cpSync).toHaveBeenCalled();
  });

  it('skips sync when .base-version matches current version', async () => {
    mockExistsPaths({});
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version')) return '2026-02-27\n';
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

    mockExistsPaths({});
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

  it('skips mount when cpSync fails during sync', async () => {
    mockExistsPaths({});
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version')) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return '';
    }) as typeof fs.readFileSync);
    // cpSync throws → syncFailed = true
    mockedFs.cpSync.mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    // index.ts doesn't exist → mount should be skipped
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('index.ts')) return false;
      if (s.includes('.keep-local-agent-runner')) return false;
      if (s.includes('agent-runner-src')) return true;
      if (s.endsWith(path.join('container', 'agent-runner', 'src')))
        return true;
      return false;
    });

    await runAndClose();

    // Should have logged the error
    const { logger } = await import('./logger.js');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ group: 'test-group' }),
      expect.stringContaining('Failed to sync agent-runner'),
    );
  });
});

/**
 * Tests for personality versioning (snapshotPersonality).
 *
 * Exercised indirectly through runContainerAgent → buildVolumeMounts → snapshotPersonality.
 * We verify by checking which fs operations (readFileSync, writeFileSync, mkdirSync) were called
 * with personality-related paths.
 */
describe('personality versioning', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.clearAllMocks();
    mockedFs.existsSync.mockImplementation(() => false);
    (mockedFs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);
    mockedFs.statSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runAndClose() {
    const promise = runContainerAgent(testGroup, testInput, () => {});
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: null })}\n${OUTPUT_END_MARKER}\n`,
    );
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    return promise;
  }

  it('creates history snapshot when personality.md changes', async () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('agent-runner-src')) return true;
      if (s.endsWith(path.join('container', 'agent-runner', 'src')))
        return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      const s = String(p);
      if (s.includes('.base-version')) return '2026-02-27\n';
      if (s.includes('personality.md')) return 'User likes jokes';
      if (s.includes('.personality-hash')) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return '';
    }) as typeof fs.readFileSync);

    await runAndClose();

    // Should have written to evolution/history/
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('evolution/history/'),
      'User likes jokes',
    );
    // Should have written the hash file
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.personality-hash'),
      expect.any(String),
    );
  });

  it('no-op when personality.md has not changed (hash match)', async () => {
    const crypto = await import('crypto');
    const expectedHash = crypto
      .createHash('sha256')
      .update('User likes jokes')
      .digest('hex');

    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('agent-runner-src')) return true;
      if (s.endsWith(path.join('container', 'agent-runner', 'src')))
        return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      const s = String(p);
      if (s.includes('.base-version')) return '2026-02-27\n';
      if (s.includes('personality.md')) return 'User likes jokes';
      if (s.includes('.personality-hash')) return expectedHash;
      return '';
    }) as typeof fs.readFileSync);

    await runAndClose();

    // Should NOT have written to evolution/history/
    expect(mockedFs.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('evolution/history/'),
      expect.any(String),
    );
  });

  it('handles missing personality.md gracefully', async () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('agent-runner-src')) return true;
      if (s.endsWith(path.join('container', 'agent-runner', 'src')))
        return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      const s = String(p);
      if (s.includes('.base-version')) return '2026-02-27\n';
      if (s.includes('personality.md')) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return '';
    }) as typeof fs.readFileSync);

    // Should not throw
    await runAndClose();

    // Should NOT have written to evolution/history/
    expect(mockedFs.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('evolution/history/'),
      expect.any(String),
    );
  });

  it('caps history at 30 files', async () => {
    const historyFiles = Array.from(
      { length: 35 },
      (_, i) => `2026-02-${String(i + 1).padStart(2, '0')}T00-00-00-000Z.md`,
    );

    const deletedHistoryFiles: string[] = [];

    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('agent-runner-src')) return true;
      if (s.endsWith(path.join('container', 'agent-runner', 'src')))
        return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      const s = String(p);
      if (s.includes('.base-version')) return '2026-02-27\n';
      if (s.includes('personality.md')) return 'New personality content';
      if (s.includes('.personality-hash')) return 'old-hash';
      return '';
    }) as typeof fs.readFileSync);
    (mockedFs.readdirSync as ReturnType<typeof vi.fn>).mockImplementation(
      (p: fs.PathLike) => {
        const s = String(p);
        if (s.includes('evolution/history')) return historyFiles;
        return [];
      },
    );
    mockedFs.unlinkSync = vi.fn(((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('evolution/history/')) {
        deletedHistoryFiles.push(s);
      }
    }) as typeof fs.unlinkSync) as typeof mockedFs.unlinkSync;

    await runAndClose();

    // Should have deleted at least 5 files (35 - 30) plus we add 1 new = need to be at 30
    expect(deletedHistoryFiles.length).toBeGreaterThanOrEqual(5);
  });
});
