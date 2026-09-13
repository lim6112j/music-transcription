let sharedCtx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!sharedCtx) {
    sharedCtx = new AudioContext();
  }
  if (sharedCtx.state === 'suspended') {
    void sharedCtx.resume();
  }
  return sharedCtx;
}

export const MAX_AUDIO_SECONDS = 480;

export function truncateBuffer(buffer: AudioBuffer, maxSeconds: number): AudioBuffer {
  if (buffer.duration <= maxSeconds) return buffer;
  const ctx = getAudioContext();
  const frames = Math.floor(maxSeconds * buffer.sampleRate);
  const out = ctx.createBuffer(buffer.numberOfChannels, frames, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.copyToChannel(buffer.getChannelData(ch).subarray(0, frames), ch);
  }
  return out;
}

export async function decodeArrayBuffer(data: ArrayBuffer): Promise<AudioBuffer> {
  const buffer = await getAudioContext().decodeAudioData(data);
  return truncateBuffer(buffer, MAX_AUDIO_SECONDS);
}

export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  return decodeArrayBuffer(await file.arrayBuffer());
}

export class MicRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  async stop(): Promise<AudioBuffer> {
    if (!this.recorder) throw new Error('Not recording');
    const done = new Promise<void>((resolve) => {
      this.recorder!.onstop = () => resolve();
    });
    this.recorder.stop();
    await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    const blob = new Blob(this.chunks, { type: this.recorder.mimeType });
    this.recorder = null;
    this.stream = null;
    if (blob.size === 0) throw new Error('Recording was empty');
    return decodeArrayBuffer(await blob.arrayBuffer());
  }
}
