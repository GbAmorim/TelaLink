// Converte o som do computador (PCM 16 bits, estéreo, 48 kHz, vindo do processo principal)
// em uma faixa de áudio WebRTC que pode ser enviada junto com o vídeo.

const WORKLET_SOURCE = `
class TelaLinkPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.buffered = 0;
    this.port.onmessage = (event) => {
      const block = event.data;
      this.queue.push(block);
      this.buffered += block.length / 2;
      // Mantém no máximo ~200 ms na fila para o som não ficar atrasado em relação ao vídeo.
      while (this.buffered > 9600 && this.queue.length > 1) {
        const dropped = this.queue.shift();
        this.buffered -= dropped.length / 2 - this.offset;
        this.offset = 0;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || out[0];
    for (let i = 0; i < left.length; i++) {
      const block = this.queue[0];
      if (!block) { left[i] = 0; right[i] = 0; continue; }
      left[i] = block[this.offset * 2];
      right[i] = block[this.offset * 2 + 1];
      this.offset++;
      this.buffered--;
      if (this.offset * 2 >= block.length) { this.queue.shift(); this.offset = 0; }
    }
    return true;
  }
}
registerProcessor("telalink-pcm", TelaLinkPcm);
`;

export type SystemAudioHandle = { track: MediaStreamTrack; stop: () => void };

// Só a captura mais recente pode parar a captura nativa (evita que a troca de fonte encerre a nova).
let currentSession = 0;

export async function createSystemAudioTrack(): Promise<SystemAudioHandle | null> {
  const api = window.telalink?.audio;
  if (!api) return null;

  const session = ++currentSession;
  const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  let removeListener: (() => void) | null = null;
  const cleanup = () => {
    removeListener?.();
    removeListener = null;
    void context.close().catch(() => undefined);
  };

  try {
    await context.resume().catch(() => undefined);
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }

    const node = new AudioWorkletNode(context, "telalink-pcm", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const destination = context.createMediaStreamDestination();
    node.connect(destination);

    removeListener = api.onChunk((chunk) => {
      const usable = chunk.byteLength - (chunk.byteLength % 4); // estéreo 16 bits = 4 bytes por quadro
      if (usable <= 0) return;
      const samples = new Int16Array(chunk.buffer, chunk.byteOffset, usable / 2);
      const floats = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;
      node.port.postMessage(floats, [floats.buffer]);
    });

    if (!(await api.start())) { cleanup(); return null; }

    const track = destination.stream.getAudioTracks()[0];
    return {
      track,
      stop: () => {
        if (session === currentSession) void api.stop();
        track.stop();
        cleanup();
      },
    };
  } catch (error) {
    console.error("Falha ao preparar o som do computador", error);
    cleanup();
    return null;
  }
}
