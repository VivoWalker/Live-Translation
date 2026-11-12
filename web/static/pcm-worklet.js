// Runs on the audio render thread: forwards the raw 48/16 kHz mono signal.
// Resampling to 16 kHz happens in the AudioContext itself (sampleRate: 16000).
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(1600); // 100 ms @ 16 kHz
    this._n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i];
      if (this._n === this._buf.length) {
        const out = this._buf.slice(0, this._n);
        this.port.postMessage(out, [out.buffer]);
        this._n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
