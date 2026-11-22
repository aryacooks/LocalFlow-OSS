const LARGE_MODEL_RAM_THRESHOLD_MB = 24 * 1024;

/** Flow Swift, where this platform offers it; otherwise the older RAM-based pick. */
export const SWIFT_ID = "parakeet-tdt-v2";

export function recommendedTranscriptionModelId(ramMb: number, offeredIds: string[] = []): string {
  if (offeredIds.includes(SWIFT_ID)) return SWIFT_ID;
  return ramMb >= LARGE_MODEL_RAM_THRESHOLD_MB ? "large-v3-turbo" : "small.en";
}

/** One line saying which model to start with and why. */
export function recommendationText(ramMb: number, offeredIds: string[] = []): string {
  const id = recommendedTranscriptionModelId(ramMb, offeredIds);
  if (id === SWIFT_ID) return "We recommend Flow Swift: it is our fastest and most accurate English model.";
  return id === "small.en"
    ? "Start with Flow Classic, our recommended English model for computers with less than 24 GB of RAM."
    : "With 24 GB of RAM or more, we recommend Flow Multilingual for higher accuracy and multilingual speech.";
}

export const MULTILINGUAL_NOTE = "For Hindi, other languages, or mixing them with English, choose Flow Multilingual.";

export const MODEL_MEMORY_NOTE =
  "The model loads when you start dictating, while you talk, and unloads as soon as your text is ready, so it only uses memory while you dictate.";
