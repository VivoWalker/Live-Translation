// Audio worklet: forward mono PCM, 100 ms blocks (1600 samples @ 16 kHz).
class PcmTap extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    this._buf = new Float32Array(1600);
    this._n = 0;
    this._limit = options.processorOptions?.maxPendingBlocks || 0;
    this._outstanding = 0;
    this._overrun = false;
    if (this._limit) this.port.onmessage = () => {
      this._outstanding = Math.max(0, this._outstanding - 1);
    };
  }
  process(inputs) {
    if (this._overrun) return true;
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i];
      if (this._n === this._buf.length) {
        if (this._limit && this._outstanding >= this._limit) {
          this._overrun = true;
          this.port.postMessage({ overrun: true });
          return true;
        }
        const out = this._buf.slice(0, this._n);
        if (this._limit) this._outstanding++;
        this.port.postMessage(out, [out.buffer]);
        this._n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
