export type BriefSection = {
  title: string;
  items: string[];
  recommendation?: string;
};

export type BriefDocument = {
  heading: string;
  sections: BriefSection[];
};

export function normalizeBullets(raw: string | string[] | null | undefined, fallback: string, limit = 3): string[] {
  const lines = Array.isArray(raw) ? raw : String(raw ?? "").split(/\r?\n/);
  const cleaned = lines
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => !/^no intro\.?$/i.test(line))
    .slice(0, limit);
  return cleaned.length ? cleaned : [fallback];
}

export function renderBriefSections(doc: BriefDocument): string {
  const lines = [doc.heading, ""];
  doc.sections.forEach((section, index) => {
    if (index > 0) lines.push("");
    lines.push(section.title);
    const items = section.items.length ? section.items : ["Unavailable."];
    lines.push(...items.map((item) => `- ${item}`));
    if (section.recommendation) lines.push(`Recommendation: ${section.recommendation}`);
  });
  return lines.join("\n");
}
