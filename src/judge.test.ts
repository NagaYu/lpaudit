/**
 * judge.test.ts
 * ---------------------------------------------------------------------------
 * Unit tests for the pure, network-free logic in judge.ts: JSON extraction
 * from messy model output, report normalization/coercion, and risk-band
 * derivation. These are the most failure-prone parts of the pipeline because
 * LLMs return malformed or partial JSON in the wild.
 * ---------------------------------------------------------------------------
 */

import { describe, it, expect } from "vitest";

import { extractJsonObject, normalizeReport, deriveRiskLevel } from "./judge.js";
import { LpAuditError } from "./types.js";

describe("extractJsonObject", () => {
  it("returns a clean JSON object unchanged", () => {
    const input = '{"riskScore": 10}';
    expect(extractJsonObject(input)).toBe('{"riskScore": 10}');
  });

  it("strips ```json fences", () => {
    const input = '```json\n{"riskScore": 42}\n```';
    expect(JSON.parse(extractJsonObject(input))).toEqual({ riskScore: 42 });
  });

  it("strips bare ``` fences", () => {
    const input = '```\n{"a": 1}\n```';
    expect(JSON.parse(extractJsonObject(input))).toEqual({ a: 1 });
  });

  it("extracts the first balanced object from surrounding prose", () => {
    const input = 'Here is your report:\n{"riskScore": 7, "nested": {"x": 1}}\nThanks!';
    expect(JSON.parse(extractJsonObject(input))).toEqual({ riskScore: 7, nested: { x: 1 } });
  });

  it("respects braces inside string values", () => {
    const input = '{"quote": "use {curly} braces here", "ok": true}';
    expect(JSON.parse(extractJsonObject(input))).toEqual({ quote: "use {curly} braces here", ok: true });
  });

  it("respects escaped quotes inside strings", () => {
    const input = '{"quote": "he said \\"100%\\" guaranteed"}';
    expect(JSON.parse(extractJsonObject(input))).toEqual({ quote: 'he said "100%" guaranteed' });
  });

  it("throws LpAuditError when no object is present", () => {
    expect(() => extractJsonObject("no json here")).toThrow(LpAuditError);
  });

  it("throws LpAuditError on an unbalanced object", () => {
    expect(() => extractJsonObject('{"a": 1')).toThrow(LpAuditError);
  });
});

describe("deriveRiskLevel", () => {
  it.each([
    [1, "minimal"],
    [19, "minimal"],
    [20, "low"],
    [39, "low"],
    [40, "moderate"],
    [59, "moderate"],
    [60, "high"],
    [79, "high"],
    [80, "severe"],
    [100, "severe"],
  ])("maps score %i to %s", (score, level) => {
    expect(deriveRiskLevel(score)).toBe(level);
  });
});

describe("normalizeReport", () => {
  it("normalizes a complete, well-formed report", () => {
    const report = normalizeReport({
      riskScore: 87,
      riskLevel: "severe",
      summary: "  bad page  ",
      violations: [
        {
          category: "restricted_health",
          platform: ["meta", "google", "legal"],
          severity: "critical",
          quote: "必ず痩せる",
          explanation: "why",
          suggestion: "fix",
        },
      ],
      detectedCategories: ["healthcare"],
      recommendations: ["do x"],
    });

    expect(report.riskScore).toBe(87);
    expect(report.riskLevel).toBe("severe");
    expect(report.summary).toBe("bad page");
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]?.platform).toEqual(["meta", "google", "legal"]);
    expect(report.detectedCategories).toEqual(["healthcare"]);
  });

  it("clamps an out-of-range riskScore into 1..100", () => {
    expect(normalizeReport({ riskScore: 9999 }).riskScore).toBe(100);
    expect(normalizeReport({ riskScore: -50 }).riskScore).toBe(1);
  });

  it("falls back to 50 when riskScore is non-numeric", () => {
    expect(normalizeReport({ riskScore: "not a number" }).riskScore).toBe(50);
  });

  it("derives riskLevel when the model omits or corrupts it", () => {
    expect(normalizeReport({ riskScore: 85, riskLevel: "bogus" }).riskLevel).toBe("severe");
    expect(normalizeReport({ riskScore: 10 }).riskLevel).toBe("minimal");
  });

  it("coerces an invalid severity to 'medium'", () => {
    const report = normalizeReport({
      violations: [{ category: "x", severity: "apocalyptic", quote: "", explanation: "", suggestion: "" }],
    });
    expect(report.violations[0]?.severity).toBe("medium");
  });

  it("drops unknown platform tags and dedupes", () => {
    const report = normalizeReport({
      violations: [{ category: "x", platform: ["meta", "meta", "myspace", "google"], severity: "low" }],
    });
    expect(report.violations[0]?.platform).toEqual(["meta", "google"]);
  });

  it("sorts violations from most to least severe", () => {
    const report = normalizeReport({
      violations: [
        { category: "a", severity: "low" },
        { category: "b", severity: "critical" },
        { category: "c", severity: "medium" },
      ],
    });
    expect(report.violations.map((v) => v.category)).toEqual(["b", "c", "a"]);
  });

  it("defaults missing collections to empty arrays", () => {
    const report = normalizeReport({ riskScore: 30 });
    expect(report.violations).toEqual([]);
    expect(report.detectedCategories).toEqual([]);
    expect(report.recommendations).toEqual([]);
  });

  it("filters non-string entries out of string arrays", () => {
    const report = normalizeReport({
      detectedCategories: ["crypto", "", "  ", "finance"],
      recommendations: ["a", "b"],
    });
    expect(report.detectedCategories).toEqual(["crypto", "finance"]);
  });

  it("throws when the input is not an object", () => {
    expect(() => normalizeReport(null)).toThrow(LpAuditError);
    expect(() => normalizeReport("nope")).toThrow(LpAuditError);
  });
});
