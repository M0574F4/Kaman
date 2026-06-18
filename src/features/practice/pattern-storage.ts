import { DEFAULT_BACKEND_ENDPOINT } from "../../audio/backend-pipeline";
import type { PracticePattern } from "./patterns";

export type SavePracticePatternRequest = Omit<PracticePattern, "id">;

type PatternListResponse = {
  patterns: PracticePattern[];
};

type PatternSaveResponse = {
  pattern: PracticePattern;
};

export function localPatternStorageAllowed(): boolean {
  return (
    location.protocol === "http:" &&
    (location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.hostname === "::1")
  );
}

export async function fetchSavedPracticePatterns(
  endpoint = DEFAULT_BACKEND_ENDPOINT,
): Promise<PracticePattern[]> {
  ensureLocalPatternStorageAllowed();
  const response = await fetch(`${endpoint}/patterns`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Pattern storage returned ${response.status}`);
  }
  const result = (await response.json()) as PatternListResponse;
  return Array.isArray(result.patterns) ? result.patterns : [];
}

export async function savePracticePattern(
  pattern: SavePracticePatternRequest,
  endpoint = DEFAULT_BACKEND_ENDPOINT,
): Promise<PracticePattern> {
  ensureLocalPatternStorageAllowed();
  const response = await fetch(`${endpoint}/patterns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pattern),
  });
  if (!response.ok) {
    throw new Error(await errorText(response, "Pattern save failed"));
  }
  const result = (await response.json()) as PatternSaveResponse;
  return result.pattern;
}

export async function deletePracticePattern(
  id: string,
  endpoint = DEFAULT_BACKEND_ENDPOINT,
): Promise<void> {
  ensureLocalPatternStorageAllowed();
  const response = await fetch(`${endpoint}/patterns/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await errorText(response, "Pattern delete failed"));
  }
}

function ensureLocalPatternStorageAllowed(): void {
  if (!localPatternStorageAllowed()) {
    throw new Error("Saving patterns is only available from the local app.");
  }
}

async function errorText(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === "string" ? payload.error : fallback;
  } catch {
    return fallback;
  }
}
