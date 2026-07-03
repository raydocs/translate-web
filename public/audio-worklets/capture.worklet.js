class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
    this.chunkSize = Math.max(640, Math.floor(sampleRate * 0.04));
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    const merged = new Float32Array(this.buffer.length + input.length);
    merged.set(this.buffer, 0);
    merged.set(input, this.buffer.length);
    this.buffer = merged;

    while (this.buffer.length >= this.chunkSize) {
      const chunk = this.buffer.slice(0, this.chunkSize);
      this.port.postMessage(chunk, [chunk.buffer]);
      this.buffer = this.buffer.slice(this.chunkSize);
    }

    return true;
  }
}

registerProcessor("audio-capture-processor", AudioCaptureProcessor);
