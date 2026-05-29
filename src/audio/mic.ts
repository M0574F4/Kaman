export type MicHandle = {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  ownsContext: boolean;
};

export async function startMic(
  sharedContext?: AudioContext,
  micConstraintProfile: "raw" | "voice-processed" = "raw",
): Promise<MicHandle> {
  const useVoiceProcessing = micConstraintProfile === "voice-processed";
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // iOS Safari can behave better for simultaneous mic+speaker when
      // voice-processing constraints are enabled.
      echoCancellation: useVoiceProcessing,
      noiseSuppression: useVoiceProcessing,
      autoGainControl: useVoiceProcessing,
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
