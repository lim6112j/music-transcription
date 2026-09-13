import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { decodeAudioFile, MicRecorder } from './audio/audioInput';
import { transcribeAudio, type NoteEvent } from './transcribe/transcribe';
import {
  buildScore,
  detectClef,
  estimateKeySpec,
  estimateTempo,
  type BuiltScore,
} from './transcribe/notation';
import { ScoreView, SCORE_SHEET_ID } from './render/ScoreView';
import { exportScorePdf } from './render/exportPdf';

type Status = 'idle' | 'decoding' | 'analyzing' | 'ready';

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
  const [exporting, setExporting] = useState(false);

  const recorderRef = useRef<MicRecorder | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const score: BuiltScore | null = useMemo(() => {
    if (!noteEvents) return null;
    return buildScore(noteEvents, { tempo, beatsPerMeasure, clef, keySpec });
  }, [noteEvents, tempo, beatsPerMeasure, clef, keySpec]);

  const busy = status === 'decoding' || status === 'analyzing';

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
      const detectedTempo = estimateTempo(events);
      setTempo(detectedTempo);
      setKeySpec(estimateKeySpec(events, detectedTempo));
      setClef(detectClef(events));
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

  const toggleRecording = useCallback(async () => {
    if (recording) {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      setRecording(false);
      if (!recorder) return;
      try {
        setStatus('decoding');
        const buffer = await recorder.stop();
        await runTranscription(buffer, 'Microphone recording');
      } catch (e) {
        console.error(e);
        setError('Could not process the recording.');
        setStatus('idle');
      }
      return;
    }
    setError(null);
    try {
      const recorder = new MicRecorder();
      await recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError('Microphone access was denied. Allow microphone access and try again.');
    }
  }, [recording, runTranscription]);

  const handlePrint = useCallback(() => window.print(), []);

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

  const statusLabel =
    status === 'decoding'
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
          <button className="btn" onClick={handlePrint} disabled={!score}>
            Print
          </button>
          <button className="btn primary" onClick={handleExportPdf} disabled={!score || exporting}>
            {exporting ? 'Exporting…' : 'Export PDF'}
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
            <button className={`btn record${recording ? ' active' : ''}`} onClick={() => void toggleRecording()}>
              {recording ? (
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
            <p className="hint">Tempo, time signature and key are auto-detected when available.</p>
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
          {!statusLabel && score && <ScoreView score={score} />}
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
