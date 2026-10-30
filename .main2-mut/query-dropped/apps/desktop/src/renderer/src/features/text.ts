// Small wording helpers shared by features.

/** "1 report", "3 reports". Pass the plural form for irregular words ("delivery", "deliveries"). */
export function pluralize(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : pluralForm ?? `${singular}s`}`;
}
