// ── LLM place extraction (OpenAI-compatible) ────────────────────────────────
// Used by the social-import pipeline to pull place candidates out of travel
// notes (小红书正文, B站简介/字幕/转写). Any OpenAI-compatible endpoint works;
// DeepSeek is the documented default for mainland-China reachability.

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ExtractedPlace {
  name: string;
  city?: string;
  note?: string;
}

export function getLlmConfig(): LlmConfig | null {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.LLM_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: process.env.LLM_MODEL?.trim() || 'deepseek-chat',
  };
}

const EXTRACT_SYSTEM_PROMPT = `你是旅行笔记地点提取器。从用户提供的游记/攻略/视频转写文本中提取值得加入旅行计划的具体地点（景点、餐厅、酒店、商圈、車站等）。
规则：
- 只提取文本中真实提到的地点，禁止编造
- name 用文本中的地点名（保留原文语言）；city 填该地点所在城市（可从上下文推断）；note 用一句话概括文本对它的评价或提示（如"人少出片""必吃烤鱼，人均80"），没有就省略
- 忽略泛指（"市中心""海边"）和无法定位的表述
- 输出严格 JSON：{"places":[{"name":"...","city":"...","note":"..."}]}，最多 30 个，没有地点则 {"places":[]}`;

/** Extract place candidates from free text. Throws on config/API errors. */
export async function extractPlacesFromText(text: string): Promise<ExtractedPlace[]> {
  const config = getLlmConfig();
  if (!config) {
    throw Object.assign(new Error('LLM not configured (set LLM_API_KEY)'), { status: 501 });
  }

  // ponytail: hard cap keeps one request cheap; longer transcripts get truncated
  const MAX_CHARS = 24000;
  const body = {
    model: config.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: text.slice(0, MAX_CHARS) },
    ],
  };

  const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  const data = await res.json() as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok) {
    const err = new Error(`LLM API error: ${data.error?.message || res.statusText}`) as Error & { status: number };
    err.status = 502;
    throw err;
  }

  const content = data.choices?.[0]?.message?.content || '';
  return parseExtractedPlaces(content);
}

/** Tolerant JSON parse — handles bare arrays and \`\`\`json fences. Exported for tests. */
export function parseExtractedPlaces(content: string): ExtractedPlace[] {
  const stripped = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { places?: unknown[] })?.places;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .filter(p => typeof p.name === 'string' && p.name.trim())
    .slice(0, 30)
    .map(p => ({
      name: (p.name as string).trim(),
      city: typeof p.city === 'string' && p.city.trim() ? p.city.trim() : undefined,
      note: typeof p.note === 'string' && p.note.trim() ? p.note.trim() : undefined,
    }));
}
