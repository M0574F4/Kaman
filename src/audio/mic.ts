export type MicHandle = {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  ownsContext: boolean;
};

export async function startMic(sharedContext?: AudioContext): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

  const context = sharedContext ?? new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);

  return { context, stream, source, analyser, ownsContext: !sharedContext };
}

export function stopMic(handle: MicHandle): void {
  handle.source.disconnect();
  handle.analyser.disconnect();
  handle.stream.getTracks().forEach((track) => track.stop());
  if (handle.ownsContext) {
    void handle.context.close();
  }
}
