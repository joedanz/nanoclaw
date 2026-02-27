import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

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
      unlinkSync: vi.fn(),
      rmSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

const mockedFs = vi.mocked(fs);

import {
  AGENT_RUNNER_BASE_VERSION,
  syncAgentRunner,
  snapshotPersonality,
} from './evolution-host.js';

describe('syncAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockImplementation(() => false);
  });

  it('syncs runner when .base-version is missing', () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('.keep-local-agent-runner')) return false;
      if (s.includes('agent-runner-src')) return true;
      if (s.includes('/src/source')) return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version')) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return '';
    }) as typeof fs.readFileSync);

    const result = syncAgentRunner('/data/agent-runner-src', '/src/source', 'test-group');

    expect(result).toBe(true);
    expect(mockedFs.rmSync).toHaveBeenCalledWith(
      '/data/agent-runner-src',
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(mockedFs.cpSync).toHaveBeenCalledWith(
      '/src/source',
      '/data/agent-runner-src',
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.base-version'),
      `${AGENT_RUNNER_BASE_VERSION}\n`,
    );
  });

  it('syncs runner when .base-version is mismatched', () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('.keep-local-agent-runner')) return false;
      if (s.includes('agent-runner-src')) return true;
      if (s.includes('/src/source')) return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version')) return 'old-version\n';
      return '';
    }) as typeof fs.readFileSync);

    const result = syncAgentRunner('/data/agent-runner-src', '/src/source', 'test-group');

    expect(result).toBe(true);
    expect(mockedFs.rmSync).toHaveBeenCalled();
    expect(mockedFs.cpSync).toHaveBeenCalled();
  });

  it('skips sync when .base-version matches', () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('.keep-local-agent-runner')) return false;
      if (s.includes('agent-runner-src')) return true;
      if (s.includes('/src/source')) return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version')) return `${AGENT_RUNNER_BASE_VERSION}\n`;
      return '';
    }) as typeof fs.readFileSync);

    const result = syncAgentRunner('/data/agent-runner-src', '/src/source', 'test-group');

    expect(result).toBe(true);
    expect(mockedFs.rmSync).not.toHaveBeenCalled();
    expect(mockedFs.cpSync).not.toHaveBeenCalled();
  });

  it('skips sync when .keep-local-agent-runner exists', () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('.keep-local-agent-runner')) return true;
      if (s.includes('agent-runner-src')) return true;
      if (s.includes('/src/source')) return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version')) return 'old-version\n';
      return '';
    }) as typeof fs.readFileSync);

    const result = syncAgentRunner('/data/agent-runner-src', '/src/source', 'test-group');

    expect(result).toBe(true);
    expect(mockedFs.rmSync).not.toHaveBeenCalled();
    expect(mockedFs.cpSync).not.toHaveBeenCalled();
  });

  it('returns false when cpSync fails and index.ts is missing', () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.includes('index.ts')) return false;
      if (s.includes('.keep-local-agent-runner')) return false;
      if (s.includes('agent-runner-src')) return true;
      if (s.includes('/src/source')) return true;
      return false;
    });
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      if (String(p).includes('.base-version')) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return '';
    }) as typeof fs.readFileSync);
    mockedFs.cpSync.mockImplementation(() => {
      throw new Error('ENOSPC');
    });

    const result = syncAgentRunner('/data/agent-runner-src', '/src/source', 'test-group');

    expect(result).toBe(false);
  });
});

describe('snapshotPersonality', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.existsSync.mockImplementation(() => false);
    (mockedFs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });

  it('creates history snapshot when personality.md changes', () => {
    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      const s = String(p);
      if (s.includes('personality.md')) return 'User likes jokes';
      if (s.includes('.personality-hash')) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return '';
    }) as typeof fs.readFileSync);

    snapshotPersonality('/groups/test', 'test-group');

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('evolution/history/'),
      'User likes jokes',
    );
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

    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      const s = String(p);
      if (s.includes('personality.md')) return 'User likes jokes';
      if (s.includes('.personality-hash')) return expectedHash;
      return '';
    }) as typeof fs.readFileSync);

    snapshotPersonality('/groups/test', 'test-group');

    expect(mockedFs.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('evolution/history/'),
      expect.any(String),
    );
  });

  it('handles missing personality.md gracefully', () => {
    mockedFs.readFileSync.mockImplementation((() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }) as typeof fs.readFileSync);

    // Should not throw
    snapshotPersonality('/groups/test', 'test-group');

    expect(mockedFs.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('evolution/history/'),
      expect.any(String),
    );
  });

  it('caps history at 30 files', () => {
    const historyFiles = Array.from(
      { length: 35 },
      (_, i) => `2026-02-${String(i + 1).padStart(2, '0')}T00-00-00-000Z.md`,
    );

    const deletedFiles: string[] = [];

    mockedFs.readFileSync.mockImplementation(((p: fs.PathOrFileDescriptor) => {
      const s = String(p);
      if (s.includes('personality.md')) return 'New content';
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
      deletedFiles.push(String(p));
    }) as typeof fs.unlinkSync) as typeof mockedFs.unlinkSync;

    snapshotPersonality('/groups/test', 'test-group');

    // Should have deleted at least 5 files (35 - 30) plus we add 1 new = need to be at 30
    expect(deletedFiles.length).toBeGreaterThanOrEqual(5);
  });
});
