import { execFile } from 'child_process';
import { mkdtemp, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { getAsrConfig, transcribeAudioFile } from './asrService';
import { extractPlacesFromText, getLlmConfig, type ExtractedPlace } from './llmService';
import { searchPlaces } from './mapsService';
import { insertImportedPlaces, type ImportedPlaceInput } from './placeService';
import { safeFetchFollow, SsrfBlockedError } from '../utils/ssrfGuard';

const execFileAsync = promisify(execFile);

// ── Social import pipeline ───────────────────────────────────────────────────
// 小红书/B站 link (or pasted text) → fetched content → LLM place extraction →
// geo-match via the regular place search (Amap in China mode) → insert into
// the trip with the same dedup semantics as the Google/Naver list imports.
//
// Degradation ladder per platform:
//   小红书: xiaohongshu-mcp REST (XHS_MCP_URL) → error asks user to paste text
//   B站:    view API (title+desc) + subtitles (needs BILIBILI_SESSDATA)
//           → yt-dlp + ASR transcription (needs binaries + ASR_API_KEY)
//           → title+desc only

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface SocialContent {
  platform: 'xiaohongshu' | 'bilibili' | 'text';
  title: string;
  text: string;
  sourceUrl?: string;
  /** which content sources contributed (for the UI summary) */
  parts: string[];
}

export function getXhsMcpUrl(): string | null {
  return process.env.XHS_MCP_URL?.trim().replace(/\/+$/, '') || null;
}

export function socialImportAvailable(): { llm: boolean; xhs: boolean; asr: boolean } {
  return { llm: !!getLlmConfig(), xhs: !!getXhsMcpUrl(), asr: !!getAsrConfig() };
}

// ── 小红书 via xiaohongshu-mcp REST API ──────────────────────────────────────

async function fetchXiaohongshu(url: string): Promise<SocialContent> {
  const base = getXhsMcpUrl();
  if (!base) {
    throw Object.assign(new Error('小红书抓取未配置（设置 XHS_MCP_URL 指向 xiaohongshu-mcp 服务），或直接粘贴笔记文字导入'), { status: 501 });
  }

  // Short share links (xhslink.com) 302 to the full explore URL. User-supplied,
  // so redirects go through the SSRF guard.
  let finalUrl = url;
  if (/xhslink\.com/i.test(url)) {
    const res = await safeFetchFollow(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    finalUrl = res.url;
  }
  const parsed = new URL(finalUrl);
  const feedId = parsed.pathname.split('/').filter(Boolean).pop() || '';
  const xsecToken = parsed.searchParams.get('xsec_token') || '';
  if (!feedId || !xsecToken) {
    throw Object.assign(new Error('无法从链接解析笔记 ID（需要含 xsec_token 的分享链接），或直接粘贴笔记文字导入'), { status: 400 });
  }

  // XHS_MCP_URL is admin-configured (usually localhost) — trusted, no SSRF guard.
  const res = await fetch(`${base}/api/v1/feeds/detail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feed_id: feedId, xsec_token: xsecToken, load_all_comments: false }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json() as {
    success?: boolean;
    message?: string;
    data?: { data?: { note?: { title?: string; desc?: string } } };
  };
  if (!res.ok || !body.success) {
    throw Object.assign(new Error(`小红书抓取失败: ${body.message || res.statusText}（可检查 xiaohongshu-mcp 登录态，或直接粘贴笔记文字导入）`), { status: 502 });
  }
  const note = body.data?.data?.note;
  const title = note?.title || '';
  const desc = note?.desc || '';
  if (!title && !desc) {
    throw Object.assign(new Error('笔记内容为空，或直接粘贴笔记文字导入'), { status: 404 });
  }
  return { platform: 'xiaohongshu', title, text: `${title}\n${desc}`, sourceUrl: finalUrl, parts: ['正文'] };
}

// ── B站 ──────────────────────────────────────────────────────────────────────

function bilibiliHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': UA, Referer: 'https://www.bilibili.com' };
  const sessdata = process.env.BILIBILI_SESSDATA?.trim();
  if (sessdata) headers.Cookie = `SESSDATA=${sessdata}`;
  return headers;
}

async function fetchBilibiliSubtitles(bvid: string, cid: number): Promise<string | null> {
  try {
    // Legacy non-wbi player endpoint — subtitle listing generally needs a
    // logged-in SESSDATA cookie; anonymous requests just return no subtitles.
    const res = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, {
      headers: bilibiliHeaders(), signal: AbortSignal.timeout(15000),
    });
    const data = await res.json() as { data?: { subtitle?: { subtitles?: { lan: string; subtitle_url: string }[] } } };
    const subs = data.data?.subtitle?.subtitles || [];
    const pick = subs.find(s => s.lan?.startsWith('zh') || s.lan?.startsWith('ai-zh')) || subs[0];
    if (!pick?.subtitle_url) return null;
    const subUrl = pick.subtitle_url.startsWith('//') ? `https:${pick.subtitle_url}` : pick.subtitle_url;
    const subRes = await fetch(subUrl, { headers: bilibiliHeaders(), signal: AbortSignal.timeout(15000) });
    const subData = await subRes.json() as { body?: { content?: string }[] };
    const text = (subData.body || []).map(l => l.content || '').join('\n').trim();
    return text || null;
  } catch (err) {
    console.warn('[SocialImport] Bilibili subtitle fetch failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function binaryExists(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ['--version'], { timeout: 10000 });
    return true;
  } catch { return false; }
}

/** yt-dlp handles wbi/referer/dash + ffmpeg remux for us — no signing code to maintain. */
async function transcribeBilibiliAudio(videoUrl: string): Promise<string | null> {
  if (!getAsrConfig()) return null;
  if (!(await binaryExists('yt-dlp'))) {
    console.warn('[SocialImport] yt-dlp not found on PATH — skipping audio transcription');
    return null;
  }
  const dir = await mkdtemp(join(tmpdir(), 'social-asr-'));
  try {
    await execFileAsync('yt-dlp', [
      '-x', '--audio-format', 'm4a', '--audio-quality', '5',
      '--max-filesize', '45m', '--no-playlist',
      '-o', join(dir, 'audio.%(ext)s'), videoUrl,
    ], { timeout: 300000 });
    const files = await readdir(dir);
    const audio = files.find(f => f.startsWith('audio.'));
    if (!audio) return null;
    const text = await transcribeAudioFile(join(dir, audio));
    return text.trim() || null;
  } catch (err) {
    console.warn('[SocialImport] Bilibili ASR ladder failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    void rm(dir, { recursive: true, force: true });
  }
}

async function fetchBilibili(url: string): Promise<SocialContent> {
  let finalUrl = url;
  if (/b23\.tv/i.test(url)) {
    const res = await safeFetchFollow(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    finalUrl = res.url;
  }
  const bvid = finalUrl.match(/BV[0-9A-Za-z]{10}/)?.[0];
  if (!bvid) throw Object.assign(new Error('无法从链接解析 B站视频 BV 号'), { status: 400 });

  const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    headers: bilibiliHeaders(), signal: AbortSignal.timeout(15000),
  });
  const view = await viewRes.json() as {
    code?: number; message?: string;
    data?: { title?: string; desc?: string; cid?: number };
  };
  if (!viewRes.ok || view.code !== 0 || !view.data) {
    throw Object.assign(new Error(`B站视频信息获取失败: ${view.message || viewRes.statusText}`), { status: 502 });
  }

  const { title = '', desc = '', cid } = view.data;
  const parts = ['标题', '简介'];
  let transcript: string | null = null;

  if (cid) {
    transcript = await fetchBilibiliSubtitles(bvid, cid);
    if (transcript) parts.push('字幕');
  }
  if (!transcript) {
    transcript = await transcribeBilibiliAudio(`https://www.bilibili.com/video/${bvid}`);
    if (transcript) parts.push('语音转写');
  }

  const text = [title, desc, transcript].filter(Boolean).join('\n\n');
  return { platform: 'bilibili', title, text, sourceUrl: `https://www.bilibili.com/video/${bvid}`, parts };
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

export async function fetchSocialContent(input: { url?: string; text?: string }): Promise<SocialContent> {
  const url = input.url?.trim();
  if (url) {
    try {
      if (/xhslink\.com|xiaohongshu\.com/i.test(url)) return await fetchXiaohongshu(url);
      if (/b23\.tv|bilibili\.com/i.test(url)) return await fetchBilibili(url);
    } catch (err) {
      if (err instanceof SsrfBlockedError) throw Object.assign(new Error('URL is not allowed'), { status: 400 });
      throw err;
    }
    throw Object.assign(new Error('暂不支持该链接，目前支持小红书 / B站，或直接粘贴文字导入'), { status: 400 });
  }
  const text = input.text?.trim();
  if (!text) throw Object.assign(new Error('需要提供链接或文字内容'), { status: 400 });
  return { platform: 'text', title: text.slice(0, 40), text, parts: ['粘贴文字'] };
}

export interface SocialImportResult {
  places: unknown[];
  skipped: number;
  listName: string;
  parts: string[];
  unmatched: string[];
}

/** Full pipeline: fetch → LLM extract → geo-match → insert (with dedup). */
export async function importSocial(
  tripId: string,
  userId: number,
  input: { url?: string; text?: string },
  lang?: string,
): Promise<SocialImportResult> {
  const content = await fetchSocialContent(input);
  const candidates = await extractPlacesFromText(content.text);
  if (candidates.length === 0) {
    throw Object.assign(new Error('未能从内容中提取到地点'), { status: 422 });
  }

  const matched: ImportedPlaceInput[] = [];
  const unmatched: string[] = [];
  for (const c of candidates) {
    const place = await matchPlace(userId, c, lang);
    if (place) matched.push(place);
    else unmatched.push(c.name);
  }
  if (matched.length === 0) {
    throw Object.assign(new Error('提取到地点但均未匹配到坐标'), { status: 422 });
  }

  const { places, skipped } = insertImportedPlaces(tripId, matched);
  return {
    places,
    skipped,
    listName: content.title || content.platform,
    parts: content.parts,
    unmatched,
  };
}

/** Geo-match one candidate through the regular place search (Amap/Google/OSM). */
async function matchPlace(userId: number, candidate: ExtractedPlace, lang?: string): Promise<ImportedPlaceInput | null> {
  const query = candidate.city ? `${candidate.city} ${candidate.name}` : candidate.name;
  try {
    const { places } = await searchPlaces(userId, query, lang);
    const hit = (places as { name?: string; lat?: number | null; lng?: number | null; address?: string; osm_id?: string | null; google_place_id?: string | null }[])
      .find(p => p.lat != null && p.lng != null);
    if (!hit) return null;
    return {
      name: candidate.name,
      lat: hit.lat!,
      lng: hit.lng!,
      notes: candidate.note || null,
      address: hit.address || null,
      osmId: hit.osm_id || null,
      googlePlaceId: hit.google_place_id || null,
    };
  } catch (err) {
    console.warn(`[SocialImport] geo-match failed for "${query}":`, err instanceof Error ? err.message : err);
    return null;
  }
}
