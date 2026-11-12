// Probe worklet: posts a tick every render quantum that carries input.
class Probe extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.length);
    return true;
  }
}
registerProcessor('probe', Probe);
