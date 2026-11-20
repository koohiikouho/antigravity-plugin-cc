// Structured review output. agy enforces the schema with --json-schema, and the
// final stream-json `result` carries the parsed object as `structured_output`
// (verified on agy 1.5.13).

export const SEVERITIES = ["critical", "high", "medium", "low"];
export const VERDICTS = ["ship", "ship-with-nits", "needs-work"];

export const REVIEW_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "title", "detail"],
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          file: { type: "string" },
          line: { type: "integer" },
          title: { type: "string" },
          detail: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
    next_steps: { type: "array", items: { type: "string" } },
  },
});

const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * Validate agy's structured_output defensively. Returns a normalized review
 * with findings sorted most severe first, or null when the shape is unusable
 * (callers then fall back to the prose response).
 */
export function normalizeReview(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const verdict = str(raw.verdict);
  if (!VERDICTS.includes(verdict)) return null;
  const findings = (Array.isArray(raw.findings) ? raw.findings : [])
    .filter((f) => f && typeof f === "object")
    .map((f) => ({
      severity: SEVERITIES.includes(str(f.severity)) ? str(f.severity) : "low",
      file: str(f.file),
      line: Number.isInteger(f.line) && f.line > 0 ? f.line : null,
      title: str(f.title) || "(untitled finding)",
      detail: str(f.detail),
      fix: str(f.fix),
    }))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const nextSteps = (Array.isArray(raw.next_steps) ? raw.next_steps : []).map(str).filter(Boolean);
  return { verdict, summary: str(raw.summary), findings, nextSteps };
}
