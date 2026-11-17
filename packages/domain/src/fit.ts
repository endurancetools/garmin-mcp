import type { FitActivity } from 'garmin-mcp-fit';

export type { FitActivity, FitGearChange, FitRecord } from 'garmin-mcp-fit';

/**
 * Decodes a FIT activity file. The parser (`garmin-mcp-fit`) is imported on first use only, so
 * starting the server and listing tools never load it; keep every import of it here and dynamic.
 */
export async function readFitFile(bytes: Uint8Array): Promise<FitActivity> {
  const { readFit } = await import('garmin-mcp-fit');
  return readFit(bytes);
}
