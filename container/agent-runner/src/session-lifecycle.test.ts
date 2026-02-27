import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

// Mock fs before importing the module under test
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ''),
      writeFileSync: vi.fn(),
      appendFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ mtimeMs: 0 })),
      unlinkSync: vi.fn(),
    },
  };
});

const mockedFs = vi.mocked(fs);

const { createSessionTracker } = await import('./session-lifecycle.js');

describe('createSessionTracker', () => {
  const mockLog = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockedFs.writeFileSync.mockImplementation(vi.fn());
    mockedFs.appendFileSync.mockImplementation(vi.fn());
    mockedFs.mkdirSync.mockImplementation(vi.fn());
    mockedFs.readdirSync.mockReturnValue([] as unknown as fs.Dirent[]);
  });

  it('tracks query count and writes metrics on session end', () => {
    const tracker = createSessionTracker({
      isScheduledTask: false,
      firstPrompt: 'Hello',
    }, mockLog);

    tracker.onQueryStart();
    tracker.onQueryStart();
    tracker.onQueryStart();
    tracker.onSessionEnd(false);

    // Should have written session-end summary with messageCount=3
    const summaryCall = mockedFs.writeFileSync.mock.calls.find(call =>
      String(call[0]).includes('session-end'),
    );
    expect(summaryCall).toBeDefined();
    const parsed = JSON.parse(summaryCall![1] as string);
    expect(parsed.messageCount).toBe(3);

    // Should have written metrics with queryCount=3
    expect(mockedFs.appendFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/metrics\/\d{4}-\d{2}-\d{2}\.jsonl$/),
      expect.stringContaining('"queryCount":3'),
    );
  });

  it('skips staging when isScheduledTask is true', () => {
    const tracker = createSessionTracker({
      isScheduledTask: true,
      firstPrompt: 'Reflection task',
    }, mockLog);

    tracker.onQueryStart();
    tracker.onSessionEnd(false);

    // Should NOT write session-end summary (prevents reflection loops)
    const summaryCall = mockedFs.writeFileSync.mock.calls.find(call =>
      String(call[0]).includes('session-end'),
    );
    expect(summaryCall).toBeUndefined();

    // But should still write metrics
    expect(mockedFs.appendFileSync).toHaveBeenCalled();
  });

  it('passes hadError to metrics', () => {
    const tracker = createSessionTracker({
      isScheduledTask: false,
      firstPrompt: 'Test',
    }, mockLog);

    tracker.onQueryStart();
    tracker.onSessionEnd(true);

    expect(mockedFs.appendFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('"hadError":true'),
    );
  });

  it('accumulates SDK message counts', () => {
    const tracker = createSessionTracker({
      isScheduledTask: false,
      firstPrompt: 'Test',
    }, mockLog);

    tracker.onQueryStart();
    tracker.addSdkMessages(15);
    tracker.onQueryStart();
    tracker.addSdkMessages(22);
    tracker.onSessionEnd(false);

    const appendCall = mockedFs.appendFileSync.mock.calls[0];
    const line = JSON.parse((appendCall![1] as string).trim());
    expect(line.queryCount).toBe(2);
    expect(line.sdkMessageCount).toBe(37);
  });

  it('records duration correctly', async () => {
    const tracker = createSessionTracker({
      isScheduledTask: false,
      firstPrompt: 'Test',
    }, mockLog);

    tracker.onQueryStart();

    // Small delay to ensure duration > 0
    await new Promise(r => setTimeout(r, 10));

    tracker.onSessionEnd(false);

    expect(mockedFs.appendFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/"sessionDuration":\d+/),
    );
  });
});
