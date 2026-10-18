const LARGE_MODEL_RAM_THRESHOLD_MB = 24 * 1024;

export function recommendedTranscriptionModelId(ramMb: number): string {
  return ramMb >= LARGE_MODEL_RAM_THRESHOLD_MB ? "large-v3-turbo" : "small.en";
}

export const MODEL_MEMORY_NOTE =
  "RAM figures estimate peak usage while processing speech. The model stays loaded for about 90 seconds after use so follow-up dictations start quickly, then unloads automatically. Idle memory target: around 50 MB once the model unloads; actual usage varies by device and open windows.";
