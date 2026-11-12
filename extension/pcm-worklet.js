// Audio worklet: forward mono PCM, 100 ms blocks (1600 samples @ 16 kHz).
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(1600);
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
