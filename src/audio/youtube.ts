// self-hosted instance (see README "Transcribing from a YouTube URL");
// the official api.cobalt.tools is bot-protected and cannot serve YouTube
export const DEFAULT_COBALT_ENDPOINT = 'http://localhost:4939';
const ENDPOINT_STORAGE_KEY = 'staffscribe.cobaltEndpoint';
const API_KEY_STORAGE_KEY = 'staffscribe.cobaltApiKey';

/** Audio source metadata for the sidebar display. */
export interface ResolvedAudio {
  file: File;
  sourceName: string;
}

interface CobaltSuccess {
  status: 'tunnel' | 'redirect' | 'local-processing' | 'picker';
  url?: string;
  filename?: string;
}

interface CobaltError {
  status: 'error';
  error: { code?: string; context?: { error?: Record<string, unknown> } };
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

export function isYouTubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function loadCobaltEndpoint(): string {
  return localStorage.getItem(ENDPOINT_STORAGE_KEY) || DEFAULT_COBALT_ENDPOINT;
}

export function saveCobaltEndpoint(endpoint: string): void {
  if (endpoint.trim() === DEFAULT_COBALT_ENDPOINT) localStorage.removeItem(ENDPOINT_STORAGE_KEY);
  else localStorage.setItem(ENDPOINT_STORAGE_KEY, endpoint.trim());
}

export function loadCobaltApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE_KEY) ?? '';
}

export function saveCobaltApiKey(key: string): void {
  if (key.trim() === '') localStorage.removeItem(API_KEY_STORAGE_KEY);
  else localStorage.setItem(API_KEY_STORAGE_KEY, key.trim());
}

/** Map cobalt error codes to actionable user messages. */
function cobaltErrorMessage(code: string): string {
  if (code.includes('auth.jwt')) {
    return 'This cobalt instance requires authentication. Set an instance URL and API key below the YouTube field.';
  }
  if (code.includes('auth.apikey')) return 'The cobalt instance rejected the API key. Check it and try again.';
  if (code.includes('rate_limit') || code.includes('ratelimit')) {
    return 'The cobalt instance is rate-limiting requests. Wait a moment or use a different instance.';
  }
  if (code.includes('youtube.login')) {
    return 'This cobalt instance cannot access YouTube (needs sign-in cookies). Try another instance or self-host one — see README.';
  }
  if (code.includes('youtube.private') || code.includes('content.video.private')) {
    return 'That video is private or unavailable for download.';
  }
  if (code.includes('empty') || code.includes('fail')) {
    return 'Could not extract audio from this URL. The video may be unavailable in your region.';
  }
  return `The cobalt instance could not process this URL (${code}). Try another instance or upload the file directly.`;
}

/**
 * Resolve a YouTube URL to an audio file via a cobalt API instance:
 * POST the URL, then fetch the tunnel/redirect stream it hands back.
 */
export async function fetchYouTubeAudio(url: string, endpoint: string): Promise<ResolvedAudio> {
  if (!isYouTubeUrl(url)) throw new Error('That does not look like a YouTube URL.');

  const apiKey = loadCobaltApiKey();
  let response: Response;
  try {
    response = await fetch(endpoint.trim().replace(/\/+$/, ''), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Api-Key ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        url: url.trim(),
        downloadMode: 'audio',
        audioFormat: 'mp3',
        filenameStyle: 'basic',
      }),
    });
  } catch {
    throw new Error(
      `Could not reach the cobalt instance (${endpoint}). Check the URL or self-host an instance — see README.`,
    );
  }

  let payload: CobaltSuccess | CobaltError;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`The cobalt instance returned an invalid response (HTTP ${response.status}).`);
  }

  if (payload.status === 'error') {
    throw new Error(cobaltErrorMessage(payload.error.code ?? ''));
  }
  if ((payload.status !== 'tunnel' && payload.status !== 'redirect') || !payload.url) {
    throw new Error(
      'The cobalt instance returned an unsupported response for this URL. Try another instance.',
    );
  }

  let audio: Response;
  try {
    audio = await fetch(payload.url);
  } catch {
    throw new Error('Could not download the audio stream from the cobalt instance.');
  }
  if (!audio.ok) throw new Error(`Audio download failed (HTTP ${audio.status}).`);

  const blob = await audio.blob();
  if (blob.size === 0) throw new Error('The cobalt instance returned an empty audio file.');
  const filename = payload.filename ?? 'youtube-audio.mp3';
  return { file: new File([blob], filename, { type: blob.type || 'audio/mpeg' }), sourceName: filename };
}
