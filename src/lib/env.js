// Environment + binary resolution. Keys are read here only; never logged.
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function onPath(bin) {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return bin;
  } catch {
    return null;
  }
}

// Prefer system ffmpeg (newer); fall back to the npm-bundled static build.
export const FFMPEG = onPath('ffmpeg') || require('ffmpeg-static');
export const FFPROBE = onPath('ffprobe') || require('ffprobe-static').path;

export const env = {
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  arkKey: process.env.ARK_API_KEY || '',
  arkBaseUrl: (process.env.ARK_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3').replace(/\/$/, ''),
  seedanceModel: process.env.SEEDANCE_MODEL || 'seedance-1-0-pro-250528',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  // Hard budget for AI clip generation; after this we fall back to screenshot motion.
  clipTimeoutMs: Number(process.env.CLIP_TIMEOUT_MS || 6 * 60 * 1000),
};

export function hasAnthropic() { return env.anthropicKey.length > 10; }
export function hasArk() { return env.arkKey.length > 10; }
