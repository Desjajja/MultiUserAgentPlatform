import { describe, expect, it } from 'bun:test';

import {
  parseSdkOpenAIContinuation,
  serializeSdkOpenAIContinuation,
  trimSdkOpenAITranscript,
} from './sdk-openai.js';

describe('sdk-openai continuation', () => {
  it('restores transcript from serialized continuation', () => {
    const raw = serializeSdkOpenAIContinuation([
      { role: 'user', content: '我叫测试员A' },
      { role: 'assistant', content: '你好，测试员A' },
    ]);
    expect(parseSdkOpenAIContinuation(raw)).toEqual([
      { role: 'user', content: '我叫测试员A' },
      { role: 'assistant', content: '你好，测试员A' },
    ]);
  });

  it('treats legacy sdk-* tokens as empty transcript', () => {
    expect(parseSdkOpenAIContinuation('sdk-1781172092106')).toEqual([]);
  });

  it('trims transcript by turn count', () => {
    const turns = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn-${index}`,
    }));
    expect(trimSdkOpenAITranscript(turns)).toHaveLength(64);
  });
});
