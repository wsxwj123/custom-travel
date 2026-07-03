/**
 * Unit tests for llmService.parseExtractedPlaces — the tolerant JSON parser
 * between the LLM response and the social-import pipeline.
 */
import { describe, it, expect } from 'vitest';
import { parseExtractedPlaces } from '../../../src/services/llmService';

describe('parseExtractedPlaces', () => {
  it('parses the canonical {"places":[...]} shape', () => {
    const out = parseExtractedPlaces('{"places":[{"name":"洪崖洞","city":"重庆","note":"夜景必看"}]}');
    expect(out).toEqual([{ name: '洪崖洞', city: '重庆', note: '夜景必看' }]);
  });

  it('accepts a bare array and strips ```json fences', () => {
    const out = parseExtractedPlaces('```json\n[{"name":"磁器口"}]\n```');
    expect(out).toEqual([{ name: '磁器口', city: undefined, note: undefined }]);
  });

  it('drops entries without a usable name and caps at 30', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `地点${i}` }));
    const out = parseExtractedPlaces(JSON.stringify({ places: [{ city: '成都' }, { name: '  ' }, ...many] }));
    expect(out).toHaveLength(30);
    expect(out[0].name).toBe('地点0');
  });

  it('returns [] on garbage', () => {
    expect(parseExtractedPlaces('抱歉，我无法解析')).toEqual([]);
    expect(parseExtractedPlaces('{"places": "none"}')).toEqual([]);
  });
});
