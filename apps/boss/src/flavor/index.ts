// Flavor text entry point. The LLM never decides anything: if it is missing, slow, throws or
// returns anything that fails validation, the template writes the text instead (spec §4.4).
import { flavorProblem, type FlavorOutput, type FlavorRequest, type FlavorWriter } from "./schema";
import { TemplateFlavor, templateFlavor } from "./template";

export * from "./schema";
export { TemplateFlavor, templateFlavor, templateTaskText, templateAnnouncement } from "./template";
export { NearAiFlavor, SYSTEM_PROMPT, type NearAiOptions } from "./nearai";

export interface FlavorResult {
  output: FlavorOutput;
  source: "ai" | "template";
  /** Why the LLM output was not used (null when it was, or when no LLM is configured). */
  fallbackReason: string | null;
}

export async function writeFlavor(req: FlavorRequest, writer: FlavorWriter = TemplateFlavor): Promise<FlavorResult> {
  if (writer.source === "template") return { output: templateFlavor(req), source: "template", fallbackReason: null };
  try {
    const out = await writer.write(req);
    const problem = flavorProblem(out, req); // re-check: never trust a writer's own validation
    if (!problem) return { output: out, source: writer.source, fallbackReason: null };
    return { output: templateFlavor(req), source: "template", fallbackReason: problem };
  } catch (e) {
    return { output: templateFlavor(req), source: "template", fallbackReason: e instanceof Error ? e.message : String(e) };
  }
}
