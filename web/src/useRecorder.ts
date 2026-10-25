import { useRef, useState } from 'react';

// Tap to start, tap to stop (or stop automatically after maxMs). Resolves with the recorded audio blob.
export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const done = useRef<((b: Blob) => void) | null>(null);

  async function start(maxMs?: number): Promise<Blob> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    chunks.current = [];
    rec.ondataavailable = e => e.data.size && chunks.current.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      setRecording(false);
      done.current?.(new Blob(chunks.current, { type: rec.mimeType }));
    };
    recorder.current = rec;
    rec.start();
    setRecording(true);
    if (maxMs) setTimeout(() => rec.state === 'recording' && rec.stop(), maxMs);
    return new Promise(resolve => (done.current = resolve));
  }

  function stop() {
    recorder.current?.stop();
  }

  return { recording, start, stop };
}
