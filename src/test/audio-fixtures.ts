export function sineWave(
  frequencyHz: number,
  sampleRate: number,
  sampleCount: number,
  amplitude = 0.6,
): Float32Array {
  const buffer = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    buffer[i] = amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
  }
  return buffer;
}

export function silence(sampleCount: number): Float32Array {
  return new Float32Array(sampleCount);
}
