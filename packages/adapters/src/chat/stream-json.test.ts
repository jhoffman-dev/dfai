import { describe, expect, it } from 'vitest';
import { isLoginProblem, readStreamJsonLine } from './stream-json.ts';

describe('readStreamJsonLine', () => {
  it('reads a text delta', () => {
    const line =
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}},"session_id":"s"}';
    expect(readStreamJsonLine(line)).toEqual({ kind: 'text', text: 'Hi' });
  });

  it('reads the final result, failed or not', () => {
    expect(readStreamJsonLine('{"type":"result","is_error":true,"result":"boom"}')).toEqual({
      kind: 'result',
      isError: true,
      message: 'boom',
      usage: null,
    });
    expect(readStreamJsonLine('{"type":"result","result":7}')).toEqual({
      kind: 'result',
      isError: false,
      message: '',
      usage: null,
    });
  });

  it.each([
    'not json at all',
    '[1,2]',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}',
    '{"type":"stream_event","event":{"type":"message_start"}}',
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta"}}}',
    '{"type":"rate_limit_event"}',
  ])('ignores %s', (line) => {
    expect(readStreamJsonLine(line)).toEqual({ kind: 'other' });
  });
});

describe('isLoginProblem', () => {
  it('tells a login failure from any other', () => {
    expect(isLoginProblem('Invalid API key · Please run /login')).toBe(true);
    expect(isLoginProblem('OAuth token has expired')).toBe(true);
    expect(isLoginProblem('model not found')).toBe(false);
  });
});
