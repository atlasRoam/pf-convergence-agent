import type { ModelSummary } from "@pfsaa/contracts";

export function commandModel(models: ModelSummary[], argument: string): ModelSummary | undefined {
  const value = argument.trim().toLowerCase();
  const qualified = models.find((model) => `${model.providerId}/${model.id}`.toLowerCase() === value);
  if (qualified) return qualified;
  const unqualified = models.filter((model) => model.id.toLowerCase() === value);
  return unqualified.length === 1 ? unqualified[0] : undefined;
}

export function exportArguments(argument: string): { format: "jsonl" | "html"; outputPath?: string } {
  const value = argument.trim();
  if (!value || value.toLowerCase() === "html") return { format: "html" };
  if (value.toLowerCase() === "jsonl") return { format: "jsonl" };
  // AgentCore treats the entire argument as a filename, including spaces. Quotes are
  // accepted as a convenience without interpreting escapes or shell syntax.
  const outputPath = /^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value;
  return { format: /\.jsonl$/i.test(outputPath) ? "jsonl" : "html", outputPath };
}
