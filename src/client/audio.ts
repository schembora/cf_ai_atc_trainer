// Push-to-talk capture. MediaRecorder gives us webm/opus (or mp4 on Safari);
// we decode it and re-encode as 16 kHz mono WAV, which Whisper accepts
// everywhere.

const SAMPLE_RATE = 16000;

export class PushToTalk {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  async start() {
    this.stream ??= await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start();
  }

  /** Stop recording and return a WAV blob (null if nothing was captured). */
  async stop(): Promise<Blob | null> {
    const rec = this.recorder;
    if (!rec || rec.state === "inactive") return null;
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });
    this.recorder = null;
    if (this.chunks.length === 0) return null;
    const encoded = await new Blob(this.chunks).arrayBuffer();
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(encoded);
      if (decoded.duration < 0.3) return null;
      return encodeWav(await resample(decoded));
    } finally {
      void ctx.close();
    }
  }

  release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

async function resample(buf: AudioBuffer): Promise<Float32Array> {
  const frames = Math.ceil(buf.duration * SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  return (await offline.startRendering()).getChannelData(0);
}

function encodeWav(samples: Float32Array): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => {
    const v = Math.max(-1, Math.min(1, s));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  });
  return new Blob([view], { type: "audio/wav" });
}

/** Read ATC transmissions aloud with the browser's speech synthesis. */
export function speak(text: string) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.1;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  u.voice = voices.find((v) => /Daniel|Alex|Fred|Google US/i.test(v.name)) ?? voices[0] ?? null;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
