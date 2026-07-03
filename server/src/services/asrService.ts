import { readFile } from 'fs/promises';

// ── ASR transcription (OpenAI-compatible /v1/audio/transcriptions) ──────────
// Default target is SiliconFlow's SenseVoice (mainland-reachable, personal
// real-name signup, OpenAI-compatible). Any compatible endpoint works.

export interface AsrConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function getAsrConfig(): AsrConfig | null {
  const apiKey = process.env.ASR_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.ASR_BASE_URL?.trim() || 'https://api.siliconflow.cn').replace(/\/+$/, ''),
    model: process.env.ASR_MODEL?.trim() || 'FunAudioLLM/SenseVoiceSmall',
  };
}

// SiliconFlow caps uploads at 50 MB / 1 h — stay under it.
export const ASR_MAX_BYTES = 45 * 1024 * 1024;

/** Transcribe an audio file (m4a/mp3/wav). Throws on config or API errors. */
export async function transcribeAudioFile(filePath: string): Promise<string> {
  const config = getAsrConfig();
  if (!config) throw Object.assign(new Error('ASR not configured (set ASR_API_KEY)'), { status: 501 });

  const bytes = await readFile(filePath);
  if (bytes.byteLength > ASR_MAX_BYTES) {
    throw Object.assign(new Error('Audio file too large for ASR'), { status: 413 });
  }

  const form = new FormData();
  form.append('model', config.model);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/mp4' }), 'audio.m4a');

  const res = await fetch(`${config.baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(300000),
  });
  const data = await res.json() as { text?: string; error?: { message?: string } };
  if (!res.ok) {
    throw Object.assign(new Error(`ASR API error: ${data.error?.message || res.statusText}`), { status: 502 });
  }
  return data.text || '';
}
