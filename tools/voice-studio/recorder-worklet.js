// Hands the microphone's raw samples to the page, 128 frames at a time.
//
// MediaRecorder would be simpler and is wrong here: it only gives compressed
// audio (Opus/AAC), and a voice model trained on codec artifacts learns them.
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('voice-tap', Tap);
