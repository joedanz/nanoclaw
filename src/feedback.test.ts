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

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((folder: string) => `/groups/${folder}`),
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
    },
  };
});

const mockedFs = vi.mocked(fs);

import {
  writeFeedback,
  filterFeedbackMessages,
  FEEDBACK_POSITIVE_PATTERN,
  FEEDBACK_NEGATIVE_PATTERN,
} from './feedback.js';
import type { NewMessage } from './types.js';

function makeMessage(content: string, senderName = 'Alice'): NewMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    chat_jid: 'group@g.us',
    sender: 'alice@s.whatsapp.net',
    sender_name: senderName,
    content,
    timestamp: new Date().toISOString(),
  };
}

describe('FEEDBACK_POSITIVE_PATTERN', () => {
  it('matches !good', () => {
    expect(FEEDBACK_POSITIVE_PATTERN.test('!good')).toBe(true);
  });
  it('matches !great', () => {
    expect(FEEDBACK_POSITIVE_PATTERN.test('!great')).toBe(true);
  });
  it('matches !perfect', () => {
    expect(FEEDBACK_POSITIVE_PATTERN.test('!perfect')).toBe(true);
  });
  it('matches !thanks', () => {
    expect(FEEDBACK_POSITIVE_PATTERN.test('!thanks')).toBe(true);
  });
  it('is case insensitive', () => {
    expect(FEEDBACK_POSITIVE_PATTERN.test('!GOOD')).toBe(true);
  });
  it('does not match partial', () => {
    expect(FEEDBACK_POSITIVE_PATTERN.test('!good job')).toBe(false);
  });
});

describe('FEEDBACK_NEGATIVE_PATTERN', () => {
  it('matches !bad', () => {
    expect(FEEDBACK_NEGATIVE_PATTERN.test('!bad')).toBe(true);
  });
  it('matches !wrong', () => {
    expect(FEEDBACK_NEGATIVE_PATTERN.test('!wrong')).toBe(true);
  });
  it('matches !no', () => {
    expect(FEEDBACK_NEGATIVE_PATTERN.test('!no')).toBe(true);
  });
  it('matches !fix', () => {
    expect(FEEDBACK_NEGATIVE_PATTERN.test('!fix')).toBe(true);
  });
  it('does not match partial', () => {
    expect(FEEDBACK_NEGATIVE_PATTERN.test('!bad response')).toBe(false);
  });
});

describe('writeFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockedFs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });

  it('writes feedback file to evolution/feedback/', () => {
    writeFeedback('test-group', {
      rating: 'positive',
      timestamp: '2026-02-27T12:00:00.000Z',
      from: 'Alice',
      contextSummary: 'Last agent response at 2026-02-27T11:55:00.000Z',
    });

    expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
      '/groups/test-group/evolution/feedback',
      { recursive: true },
    );
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(
        /\/groups\/test-group\/evolution\/feedback\/\d+-\w+\.json$/,
      ),
      expect.stringContaining('"rating": "positive"'),
    );
  });

  it('handles write errors gracefully', () => {
    mockedFs.writeFileSync.mockImplementation(() => {
      throw new Error('ENOSPC');
    });

    // Should not throw
    writeFeedback('test-group', {
      rating: 'negative',
      timestamp: '2026-02-27T12:00:00.000Z',
      from: 'Bob',
      contextSummary: 'No prior agent response in this session',
    });
  });

  it('rotates oldest files when at 100-file cap', () => {
    const files = Array.from({ length: 100 }, (_, i) => `${1000 + i}-abc.json`);
    (mockedFs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(files);

    writeFeedback('test-group', {
      rating: 'positive',
      timestamp: '2026-02-27T12:00:00.000Z',
      from: 'Alice',
      contextSummary: 'test',
    });

    // Should have deleted the oldest file
    expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('1000-abc.json'),
    );
    // And written a new one
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
  });
});

describe('filterFeedbackMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters out positive feedback and writes it', () => {
    const messages = [
      makeMessage('Hello'),
      makeMessage('!good'),
      makeMessage('How are you?'),
    ];

    const result = filterFeedbackMessages(
      messages,
      'test-group',
      'group@g.us',
      {},
    );

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Hello');
    expect(result[1].content).toBe('How are you?');
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('evolution/feedback/'),
      expect.stringContaining('"rating": "positive"'),
    );
  });

  it('filters out negative feedback and writes it', () => {
    const messages = [makeMessage('!bad')];

    const result = filterFeedbackMessages(
      messages,
      'test-group',
      'group@g.us',
      {},
    );

    expect(result).toHaveLength(0);
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('evolution/feedback/'),
      expect.stringContaining('"rating": "negative"'),
    );
  });

  it('passes through normal messages', () => {
    const messages = [makeMessage('Hello'), makeMessage('What time is it?')];

    const result = filterFeedbackMessages(
      messages,
      'test-group',
      'group@g.us',
      {},
    );

    expect(result).toHaveLength(2);
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('includes lastAgentTimestamp in contextSummary', () => {
    const messages = [makeMessage('!good')];

    filterFeedbackMessages(messages, 'test-group', 'group@g.us', {
      'group@g.us': '2026-02-27T10:00:00.000Z',
    });

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(
        'Last agent response at 2026-02-27T10:00:00.000Z',
      ),
    );
  });

  it('reports no prior agent response when timestamp missing', () => {
    const messages = [makeMessage('!good')];

    filterFeedbackMessages(messages, 'test-group', 'group@g.us', {});

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('No prior agent response in this session'),
    );
  });

  it('includes lastAgentMessage content when available', () => {
    const messages = [makeMessage('!good')];

    filterFeedbackMessages(
      messages,
      'test-group',
      'group@g.us',
      { 'group@g.us': '2026-02-27T10:00:00.000Z' },
      { 'group@g.us': 'Here is my helpful response' },
    );

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(
        'Last agent response: Here is my helpful response',
      ),
    );
  });

  it('falls back to timestamp when lastAgentMessage is empty', () => {
    const messages = [makeMessage('!good')];

    filterFeedbackMessages(
      messages,
      'test-group',
      'group@g.us',
      { 'group@g.us': '2026-02-27T10:00:00.000Z' },
      {},
    );

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(
        'Last agent response at 2026-02-27T10:00:00.000Z',
      ),
    );
  });
});
