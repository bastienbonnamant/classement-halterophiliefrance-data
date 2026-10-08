/** Seasons run Sept-Aug; scoresheet season id 3 = 2019/2020, ..., 9 = 2025/2026. */
export function currentSourceSeasonId(now = new Date()): number {
  const month = now.getMonth() + 1; // 1-12
  const startYear = month >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  return 3 + (startYear - 2019);
}

export function seasonLabelForSourceId(sourceSeasonId: number): string {
  const startYear = 2019 + (sourceSeasonId - 3);
  return `${startYear}/${startYear + 1}`;
}
