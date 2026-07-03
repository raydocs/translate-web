class PCMPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queuedSamples = 0;
    this.started = false;
    this.minBufferedSamples = Math.round(sampleRate * 0.16);
    this.maxBufferedSamples = Math.round(sampleRate * 2.4);

    this.port.onmessage = (event) => {
      if (event.data === "interrupt") {
        this.queue = [];
        this.offset = 0;
        this.queuedSamples = 0;
        this.started = false;
        return;
      }

      if (event.data instanceof Float32Array) {
        while (this.queuedSamples > this.maxBufferedSamples && this.queue.length > 1) {
          const dropped = this.queue.shift();
          this.queuedSamples -= dropped.length;
          this.offset = 0;
        }
        this.queue.push(event.data);
        this.queuedSamples += event.data.length;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || left;

    if (!this.started) {
      if (this.queuedSamples < this.minBufferedSamples) {
        left.fill(0);
        if (right !== left) right.fill(0);
        return true;
      }
      this.started = true;
    }

    let written = 0;
    while (written < left.length) {
      if (this.queue.length === 0) {
        this.started = false;
        left.fill(0, written);
        if (right !== left) right.fill(0, written);
        break;
      }

      const current = this.queue[0];
      const available = current.length - this.offset;
      const needed = left.length - written;
      const count = Math.min(available, needed);

      for (let i = 0; i < count; i += 1) {
        const sample = current[this.offset + i];
        left[written + i] = sample;
        if (right !== left) right[written + i] = sample;
      }

      written += count;
      this.offset += count;
      this.queuedSamples -= count;

      if (this.offset >= current.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-playback-processor", PCMPlaybackProcessor);
