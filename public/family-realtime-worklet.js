// Trusted same-origin code. No network, storage, credentials or dynamic eval.
class FamilyRealtimeCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.inFlight = false;
    this.generation = 0;
    this.offset = 0;
    this.samples = new Float32Array(Math.max(128, Math.round(sampleRate / 10)));
    this.port.onmessage = (event) => {
      if (event.data?.type === "gate") {
        this.enabled = event.data.enabled === true;
        this.offset = 0;
        this.inFlight = false;
        this.generation = event.data.generation ?? 0;
      }
      if (
        event.data?.type === "ack" &&
        event.data.generation === this.generation
      )
        this.inFlight = false;
    };
  }
  process(inputs, outputs) {
    // Keep the graph alive without feeding the microphone back to speakers.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!this.enabled || !channels?.length) return true;
    // Render quantum length is not guaranteed to remain 128 frames.
    const frames = Math.min(...channels.map((channel) => channel.length));
    for (let i = 0; i < frames; i++) {
      let mono = 0;
      for (const channel of channels)
        mono += Number.isFinite(channel[i]) ? channel[i] : 0;
      this.samples[this.offset++] = mono / channels.length;
      if (this.offset === this.samples.length) {
        const samples = this.samples;
        // At most one transferred batch may wait on a busy main thread.
        // Drop new batches instead of replaying an unbounded microphone backlog.
        if (!this.inFlight) {
          this.inFlight = true;
          this.port.postMessage(
            {
              type: "samples",
              samples,
              generation: this.generation,
              capturedAt: typeof currentTime === "number" ? currentTime : 0,
            },
            [samples.buffer],
          );
          this.samples = new Float32Array(samples.length);
        }
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("family-realtime-capture", FamilyRealtimeCapture);
