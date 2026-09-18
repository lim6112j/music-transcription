import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { decodeAudioFile, MicRecorder, SystemAudioRecorder, type AudioRecorder } from './audio/audioInput';
import {
  fetchYouTubeAudio,
  isYouTubeUrl,
  loadCobaltApiKey,
  loadCobaltEndpoint,
  saveCobaltApiKey,
  saveCobaltEndpoint,
} from './audio/youtube';
import { playScore, type PlaybackHandle } from './audio/playback';
import { transcribeAudio, type NoteEvent } from './transcribe/transcribe';
import { DEMO_EVENTS } from './transcribe/demo';
import { filterNoiseEvents, type NoiseFilterLevel } from './transcribe/filter';
import {
  buildScore,
  deleteTimeRange,
  detectClef,
  estimateKeySpec,
  estimateTempo,
  type BuiltScore,
} from './transcribe/notation';
import { ScoreView, SCORE_SHEET_ID, loadSpacing, saveSpacing } from './render/ScoreView';
import { exportScorePdf } from './render/exportPdf';
import { buildScoreToMusicXml } from './render/exportMusicXml';

type Status = 'idle' | 'fetching' | 'decoding' | 'analyzing' | 'ready';

const KEY_OPTIONS = [
  'C', 'G', 'D', 'A', 'E', 'B', 'F#',
  'F', 'Bb', 'Eb', 'Ab', 'Db',
  'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm',
];

const TIME_SIGNATURES = [
  { label: '4/4', beats: 4 },
  { label: '3/4', beats: 3 },
  { label: '2/4', beats: 2 },
];

export default function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [noteEvents, setNoteEvents] = useState<NoteEvent[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [tempo, setTempo] = useState(120);
  const [beatsPerMeasure, setBeatsPerMeasure] = useState(4);
  const [clef, setClef] = useState<'auto' | 'treble' | 'bass'>('auto');
  const [keySpec, setKeySpec] = useState('C');
  const [noiseFilter, setNoiseFilter] = useState<NoiseFilterLevel>('medium');
  const [spacing, setSpacing] = useState(() => loadSpacing());
  const [exporting, setExporting] = useState(false);
  const [playback, setPlayback] = useState<PlaybackHandle | null>(null);
  const [playingMeasure, setPlayingMeasure] = useState<number | null>(null);
  const [ytUrl, setYtUrl] = useState('');
  const [cobaltEndpoint, setCobaltEndpoint] = useState(() => loadCobaltEndpoint());
  const [cobaltApiKey, setCobaltApiKey] = useState(() => loadCobaltApiKey());

  const recorderRef = useRef<AudioRecorder | null>(null);
  const recordingNameRef = useRef('Microphone recording');
  const [recordingSource, setRecordingSource] = useState<'mic' | 'system' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const playbackRef = useRef<PlaybackHandle | null>(null);

  // keep raw events so changing the filter level re-derives without re-transcribing
  const filteredEvents = useMemo(
    () => (noteEvents ? filterNoiseEvents(noteEvents, noiseFilter) : null),
    [noteEvents, noiseFilter],
  );

  const score: BuiltScore | null = useMemo(() => {
    if (!filteredEvents || filteredEvents.length === 0) return null;
    const title = (fileName ?? 'Untitled').replace(/\.[^.]+$/, '');
    return buildScore(filteredEvents, { tempo, beatsPerMeasure, clef, keySpec, title });
  }, [filteredEvents, tempo, beatsPerMeasure, clef, keySpec, fileName]);

  const busy = status === 'fetching' || status === 'decoding' || status === 'analyzing';

  // stop playback if the score disappears (e.g. filter change) or on unmount
  useEffect(() => {
    if (!score) {
      playbackRef.current?.stop();
      playbackRef.current = null;
      setPlayback(null);
      setPlayingMeasure(null);
    }
  }, [score]);
  useEffect(() => () => playbackRef.current?.stop(), []);

  // dev aid: ?demo renders a synthetic two-hand score without the model
  useEffect(() => {
    if (noteEvents || !new URLSearchParams(window.location.search).has('demo')) return;
    setNoteEvents(DEMO_EVENTS);
    setFileName('demo-score.mid');
    setTempo(120);
    setKeySpec('Eb');
    setClef('auto');
    setStatus('ready');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!recording) return;
    setRecordSeconds(0);
    const id = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const runTranscription = useCallback(async (buffer: AudioBuffer, name: string) => {
    setError(null);
    setStatus('analyzing');
    setProgress(0);
    try {
      const events = await transcribeAudio(buffer, setProgress);
      if (events.length === 0) {
        setError('No notes were detected in this audio. Try a clearer recording or another file.');
        setStatus('idle');
        return;
      }
      // detect on noise-filtered events so tempo/key/clef reflect actual notes,
      // independent of the user's current filter level
      const cleaned = filterNoiseEvents(events, 'medium');
      if (cleaned.length === 0) {
        setError('Only noise was detected in this audio. Try a clearer recording or another file.');
        setStatus('idle');
        return;
      }
      const detectedTempo = estimateTempo(cleaned);
      setTempo(detectedTempo);
      setKeySpec(estimateKeySpec(cleaned, detectedTempo));
      setClef(detectClef(cleaned));
      setFileName(name);
      setNoteEvents(events);
      setStatus('ready');
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : 'Transcription failed. Please try again.');
      setStatus('idle');
    }
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      if (busy || recording) return;
      setError(null);
      setStatus('decoding');
      try {
        const buffer = await decodeAudioFile(file);
        await runTranscription(buffer, file.name);
      } catch (e) {
        console.error(e);
        setError('Could not decode this audio file. Try MP3, WAV, OGG or FLAC.');
        setStatus('idle');
      }
    },
    [busy, recording, runTranscription],
  );

  const toggleRecording = useCallback(
    async (mode: 'mic' | 'system' = 'mic') => {
    if (recording) {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      setRecording(false);
      setRecordingSource(null);
      if (!recorder) return;
      try {
        setStatus('decoding');
        const buffer = await recorder.stop();
        await runTranscription(buffer, recordingNameRef.current);
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : 'Could not process the recording.');
        setStatus('idle');
      }
      return;
    }
    setError(null);
    try {
      const recorder: AudioRecorder = mode === 'system' ? new SystemAudioRecorder() : new MicRecorder();
      recordingNameRef.current = mode === 'system' ? 'System recording' : 'Microphone recording';
      await recorder.start();
      recorderRef.current = recorder;
      setRecordingSource(mode);
      setRecording(true);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : mode === 'system' ? 'Could not start system audio recording.' : 'Microphone access was denied. Allow microphone access and try again.');
    }
    },
    [recording, runTranscription],
  );

  const handleYouTubeFetch = useCallback(async () => {
    if (busy || recording) return;
    if (!isYouTubeUrl(ytUrl)) {
      setError('That does not look like a YouTube URL.');
      return;
    }
    setError(null);
    setStatus('fetching');
    try {
      const { file, sourceName } = await fetchYouTubeAudio(ytUrl, cobaltEndpoint);
      saveCobaltEndpoint(cobaltEndpoint);
      saveCobaltApiKey(cobaltApiKey);
      const buffer = await decodeAudioFile(file);
      await runTranscription(buffer, sourceName);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : 'Could not fetch audio from that URL.');
      setStatus('idle');
    }
  }, [busy, recording, ytUrl, cobaltEndpoint, cobaltApiKey, runTranscription]);

  const handlePrint = useCallback(() => window.print(), []);

  const stopPlayback = useCallback(() => {
    playbackRef.current?.stop();
    playbackRef.current = null;
    setPlayback(null);
    setPlayingMeasure(null);
  }, []);

  const handleTogglePlayback = useCallback(() => {
    if (playbackRef.current) {
      stopPlayback();
      return;
    }
    if (!score) return;
    const handle = playScore(score, (measure) => {
      if (measure < 0) {
        // finished or stopped — reset the transport
        playbackRef.current = null;
        setPlayback(null);
        setPlayingMeasure(null);
      } else {
        setPlayingMeasure(measure);
      }
    });
    playbackRef.current = handle;
    setPlayback(handle);
  }, [score, stopPlayback]);

  // removing a staff row deletes the events sounding in its measures and
  // closes the gap, so the remaining music stays consecutive
  const handleDeleteRow = useCallback(
    (startMeasure: number, count: number) => {
      stopPlayback();
      setNoteEvents((events) => {
        if (!events) return events;
        const spb = 60 / tempo;
        const t0 = startMeasure * beatsPerMeasure * spb;
        const t1 = (startMeasure + count) * beatsPerMeasure * spb;
        return deleteTimeRange(events, t0, t1);
      });
    },
    [tempo, beatsPerMeasure, stopPlayback],
  );

  const handleExportPdf = useCallback(async () => {
    const el = document.getElementById(SCORE_SHEET_ID);
    if (!el || exporting) return;
    setExporting(true);
    try {
      await exportScorePdf(el, `${(fileName ?? 'score').replace(/\.[^.]+$/, '')}-score.pdf`);
    } catch (e) {
      console.error(e);
      setError('PDF export failed. You can still use Print and save as PDF.');
    } finally {
      setExporting(false);
    }
  }, [fileName, exporting]);

  const handleExportMusicXml = useCallback(() => {
    if (!score) return;
    try {
      const xml = buildScoreToMusicXml(score);
      const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(fileName ?? 'score').replace(/\.[^.]+$/, '')}-score.musicxml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      setError('MusicXML export failed.');
    }
  }, [score, fileName]);

  const statusLabel =
    status === 'fetching'
      ? 'Fetching audio from YouTube…'
      : status === 'decoding'
        ? 'Decoding audio…'
        : status === 'analyzing'
          ? progress < 1
            ? 'Loading transcription model…'
            : `Analyzing audio… ${Math.round(progress)}%`
          : null;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">♪</div>
          <div>
            <h1>StaffScribe</h1>
            <p>Audio to printable sheet music</p>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={handleTogglePlayback} disabled={!score || busy}>
            {playback ? '■ Stop' : '▶ Play'}
          </button>
          <button className="btn" onClick={handlePrint} disabled={!score}>
            Print
          </button>
          <button className="btn primary" onClick={handleExportPdf} disabled={!score || exporting}>
            {exporting ? 'Exporting…' : 'Export PDF'}
          </button>
          <button className="btn" onClick={handleExportMusicXml} disabled={!score}>
            MusicXML
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button aria-label="Dismiss" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <main className="app-main">
        <aside className="sidebar">
          <section className="card">
            <h2>1. Audio source</h2>
            <div
              className={`dropzone${dragOver ? ' over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const file = e.dataTransfer.files?.[0];
                if (file) void handleFile(file);
              }}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="dropzone-icon">⇪</div>
              <p>
                <strong>Drop an audio file</strong> or click to browse
              </p>
              <span className="hint">MP3 · WAV · OGG · FLAC — up to 8 minutes</span>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                  e.target.value = '';
                }}
              />
            </div>
            <div className="divider">or</div>
            <div className="yt-row">
              <input
                className="yt-input"
                type="url"
                placeholder="Paste a YouTube URL"
                value={ytUrl}
                onChange={(e) => setYtUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleYouTubeFetch();
                }}
                disabled={busy || recording}
              />
              <button
                className="btn"
                onClick={() => void handleYouTubeFetch()}
                disabled={busy || recording || ytUrl.trim() === ''}
              >
                ⇪ Fetch
              </button>
            </div>
            <details className="yt-advanced">
              <summary>Cobalt instance settings</summary>
              <label className="field">
                <span>Instance URL</span>
                <input
                  type="url"
                  value={cobaltEndpoint}
                  onChange={(e) => setCobaltEndpoint(e.target.value)}
                  placeholder="https://api.cobalt.tools"
                />
              </label>
              <label className="field">
                <span>API key (optional)</span>
                <input
                  type="password"
                  value={cobaltApiKey}
                  onChange={(e) => setCobaltApiKey(e.target.value)}
                  placeholder="Api-Key for instances that require one"
                />
              </label>
            </details>
            <p className="hint">
              YouTube audio is resolved via a cobalt API instance — only download content you have
              the right to use.
            </p>
            <div className="divider">or</div>
            <button
              className={`btn record${recording ? ' active' : ''}`}
              onClick={() => void toggleRecording('system')}
              disabled={busy || (recording && recordingSource !== 'system')}
            >
              {recording && recordingSource === 'system' ? (
                <>
                  <span className="pulse-dot" /> Stop recording ({recordSeconds}s)
                </>
              ) : (
                <>◉ Record system audio</>
              )}
            </button>
            <p className="hint">
              Pick Entire Screen and check "Share system audio" — requires Chrome 141+ on macOS
              14.2+.
            </p>
            <div className="divider">or</div>
            <button
              className={`btn record${recording ? ' active' : ''}`}
              onClick={() => void toggleRecording('mic')}
              disabled={busy || (recording && recordingSource !== 'mic')}
            >
              {recording && recordingSource === 'mic' ? (
                <>
                  <span className="pulse-dot" /> Stop recording ({recordSeconds}s)
                </>
              ) : (
                <>● Record from microphone</>
              )}
            </button>
            {fileName && status === 'ready' && <p className="source-name">Source: {fileName}</p>}
          </section>

          <section className="card">
            <h2>2. Score settings</h2>
            <label className="field">
              <span>Tempo (BPM)</span>
              <input
                type="number"
                min={40}
                max={240}
                value={tempo}
                onChange={(e) => setTempo(Math.min(240, Math.max(40, Number(e.target.value) || 120)))}
              />
            </label>
            <label className="field">
              <span>Time signature</span>
              <select value={beatsPerMeasure} onChange={(e) => setBeatsPerMeasure(Number(e.target.value))}>
                {TIME_SIGNATURES.map((ts) => (
                  <option key={ts.label} value={ts.beats}>
                    {ts.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Clef</span>
              <select value={clef} onChange={(e) => setClef(e.target.value as 'auto' | 'treble' | 'bass')}>
                <option value="auto">Auto</option>
                <option value="treble">Treble</option>
                <option value="bass">Bass</option>
              </select>
            </label>
            <label className="field">
              <span>Key signature</span>
              <select value={keySpec} onChange={(e) => setKeySpec(e.target.value)}>
                {KEY_OPTIONS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Noise filter</span>
              <select
                value={noiseFilter}
                onChange={(e) => setNoiseFilter(e.target.value as NoiseFilterLevel)}
              >
                <option value="off">Off</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="field">
              <span>Note spacing ×{spacing.toFixed(1)}</span>
              <input
                type="range"
                min={1}
                max={2.5}
                step={0.1}
                value={spacing}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setSpacing(value);
                  saveSpacing(value);
                }}
              />
            </label>
            {noteEvents && filteredEvents?.length === 0 ? (
              <p className="hint">All detected notes were filtered out — lower the noise filter.</p>
            ) : (
              <p className="hint">Tempo, time signature and key are auto-detected when available.</p>
            )}
          </section>
        </aside>

        <section className="score-area">
          {statusLabel && (
            <div className="progress-card">
              <div className="spinner" />
              <p>{statusLabel}</p>
              {status === 'analyzing' && (
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${Math.max(3, progress)}%` }} />
                </div>
              )}
              <p className="hint">Polyphonic transcription runs entirely in your browser.</p>
            </div>
          )}
          {!statusLabel && score && (
            <>
              {playingMeasure !== null && (
                <p className="hint playback-status" role="status">
                  Playing — measure {playingMeasure + 1} of {score.totalMeasures}
                </p>
              )}
              <ScoreView score={score} spacing={spacing} onDeleteRow={handleDeleteRow} />
            </>
          )}
          {!statusLabel && !score && (
            <div className="empty-state">
              <div className="empty-art">𝄞</div>
              <h2>No score yet</h2>
              <p>
                Upload an audio file or record your instrument. Detected notes appear here on the
                staff, ready to print or export as PDF.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
