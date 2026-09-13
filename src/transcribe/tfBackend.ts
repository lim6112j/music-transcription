import * as tf from '@tensorflow/tfjs';

export interface TfBackendStatus {
  backend: string;
  isFallback: boolean;
}

/**
 * Run a tiny matmul on the given backend. Shader compile errors (e.g.
 * "Failed to compile fragment shader" on some GPU/browser combos) surface
 * here, before we commit to running the whole Basic Pitch model on it.
 */
async function warmupOk(backend: string, tfLike: typeof tf): Promise<boolean> {
  try {
    if (!(await tfLike.setBackend(backend))) return false;
    await tfLike.ready();
    const a = tfLike.tensor2d([[1, 2], [3, 4]]);
    const b = tfLike.tensor2d([[1], [0]]);
    try {
      const out = tfLike.matMul(a, b);
      await out.data(); // forces real execution — where shader compilation happens
      out.dispose();
      return true;
    } finally {
      a.dispose();
      b.dispose();
    }
  } catch {
    return false;
  }
}

const cache = new Map<typeof tf, Promise<TfBackendStatus>>();

/**
 * Pick a working TF.js backend once per tf instance: WebGL if the GPU can
 * actually compile and run shaders, otherwise CPU (slower but universal).
 */
export function ensureTfBackend(tfLike: typeof tf = tf): Promise<TfBackendStatus> {
  let cached = cache.get(tfLike);
  if (!cached) {
    cached = (async () => {
      if (await warmupOk('webgl', tfLike)) return { backend: 'webgl', isFallback: false };
      if (await warmupOk('cpu', tfLike)) {
        console.warn('WebGL unavailable — falling back to the CPU backend (slower transcription).');
        return { backend: 'cpu', isFallback: true };
      }
      throw new Error('No working TensorFlow backend — WebGL and CPU both failed to initialize.');
    })();
    cache.set(tfLike, cached);
  }
  return cached;
}
