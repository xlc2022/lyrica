// Dictation's recorder: hands the microphone's samples (mono, the context's
// rate) to the page in small blocks. It keeps nothing.
class Dictation extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(Float32Array.from(channel));
    return true;
  }
}
registerProcessor("dictation", Dictation);
