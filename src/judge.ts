/**
 * judge.ts
 * ---------------------------------------------------------------------------
 * LLM policy judge.
 *
 * Takes the structured `CrawlResult` produced by the crawler, builds a strict
 * system prompt encoding the latest Meta / Google / TikTok ad policies plus
 * Japanese consumer law (特定商取引法 / 景品表示法 / 薬機法), dispatches it to
 * the configured LLM provider (OpenAI or Gemini) over axios, and parses the
 * response into a validated `AuditReport`.
 *
 * The model is instructed to return ONLY JSON. We additionally:
 *   - request JSON response mode where the provider supports it,
 *   - defensively strip markdown code fences,
 *   - extract the first balanced JSON object as a fallback,
 *   - validate and coerce every field so a malformed reply degrades gracefully
 *     instead of crashing the CLI.
 * ---------------------------------------------------------------------------
 */

import axios, { AxiosError } from "axios";

import {
  type AuditReport,
  type CrawlResult,
  type JudgeConfig,
  type Violation,
  type Severity,
  LpAuditError,
} from "./types.js";

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";
const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Cap the amount of page text we send so we stay within token / cost budgets. */
const MAX_TEXT_CHARS = 12_000;

/** Allowed severity values, used to coerce/validate model output. */
const SEVERITIES: ReadonlyArray<Severity> = ["critical", "high", "medium", "low", "info"];

/** Allowed platform tags for a violation. */
const PLATFORMS = ["meta", "google", "tiktok", "legal"] as const;
type Platform = (typeof PLATFORMS)[number];

/**
 * The system prompt. This is the heart of the auditor's expertise: it encodes
 * the concrete, current grounds on which Meta, Google, and TikTok reject ads or
 * ban accounts, plus the Japanese statutory requirements that intersect with
 * those policies.
 */
const SYSTEM_PROMPT = `You are LPAudit, a world-class senior QA and compliance engineer specializing in advertising landing-page (LP) review. You have deep, current expertise in the advertising policies of Meta (Facebook/Instagram), Google Ads, and TikTok Ads, and in Japanese consumer-protection law (特定商取引法, 景品表示法, 薬機法/医薬品医療機器等法).

Your job: given the extracted text, metadata, and structural signals of an advertising landing page, judge how likely the page is to cause AD DISAPPROVAL or ACCOUNT SUSPENSION/BAN, and explain exactly why.

Apply these policy frameworks rigorously:

1. PROHIBITED & EXAGGERATED CLAIMS
   - Absolute / superlative claims without substantiation: "No.1", "業界最安", "100%", "必ず", "確実に", "誰でも", "guaranteed", "cure", "permanent".
   - Unrealistic outcome promises, especially income ("月収100万円保証"), weight loss, or health results.
   - Before/after claims implying typical results from atypical cases.
   - Misleading scarcity / false urgency ("本日限り" with an evergreen countdown).

2. MISLEADING & DECEPTIVE DESIGN ("ユーザーを誤導するデザイン")
   - Fake system warnings, fake close buttons, fake chat, fake "as seen on" press logos.
   - Disguised ads, bait-and-switch between ad creative and LP content.
   - Forced continuity / hidden subscription terms (定期購入の不明瞭な表示) — a top reason for both platform bans and 特商法/景表法 violations.
   - Hidden or pre-checked consent, hard-to-find unsubscribe/cancellation terms.

3. RESTRICTED & SENSITIVE VERTICALS (heightened scrutiny)
   - Healthcare / supplements / medical claims (薬機法): disease treatment/prevention claims, drug-like efficacy on non-drugs.
   - Financial products, crypto / 暗号資産, "get rich quick", trading signals, MLM / ネットワークビジネス.
   - Adult content, gambling, weapons, tobacco/vaping, dating.
   - Personal attributes targeting (implying knowledge of health, religion, sexual orientation, financial hardship).

4. REQUIRED LEGAL ELEMENTS (Japan + platform trust signals)
   - 特定商取引法に基づく表記 (seller identity, address, price, delivery, returns) for any e-commerce/paid offer.
   - Privacy Policy, clear company/operator info, working contact method.
   - For 景品表示法: no 優良誤認 (overstating quality) or 有利誤認 (overstating terms/price). Required #PR/広告 disclosure where relevant.

5. TECHNICAL / TRUST SIGNALS
   - Broken or missing destination, mismatched domain vs. brand, malware/redirect chains.
   - Low-quality, thin, or scraped content; aggressive interstitials.

SCORING:
- riskScore is an integer 1–100. 1 = clean and compliant; 100 = certain disapproval/ban.
- riskLevel must be derived: 1–19 "minimal", 20–39 "low", 40–59 "moderate", 60–79 "high", 80–100 "severe".
- Be strict but fair. Quote the offending text verbatim in each violation. Give a concrete, copy-pasteable rewrite in each suggestion. Write explanations and suggestions in the SAME primary language as the landing page (Japanese page -> Japanese; English page -> English).

OUTPUT FORMAT — return ONLY a single JSON object, no prose, no markdown fences, matching exactly:
{
  "riskScore": number,                       // 1-100 integer
  "riskLevel": "minimal"|"low"|"moderate"|"high"|"severe",
  "summary": string,                         // 2-3 sentences
  "violations": [
    {
      "category": string,                    // e.g. "exaggerated_claims"
      "platform": string[],                  // subset of ["meta","google","tiktok","legal"]
      "severity": "critical"|"high"|"medium"|"low"|"info",
      "quote": string,                       // verbatim offending text ("" if structural)
      "explanation": string,
      "suggestion": string
    }
  ],
  "detectedCategories": string[],            // restricted verticals touched, e.g. ["healthcare"]
  "recommendations": string[]                // prioritized high-level fixes
}`;

/**
 * Build the user-message payload describing the crawled page. We deliberately
 * include the deterministic legal-element results so the model can reason about
 * missing notices without re-deriving them.
 */
function buildUserPrompt(crawl: CrawlResult): string {
  const text =
    crawl.innerText.length > MAX_TEXT_CHARS
      ? `${crawl.innerText.slice(0, MAX_TEXT_CHARS)}\n…[truncated, ${crawl.innerText.length - MAX_TEXT_CHARS} more chars]`
      : crawl.innerText;

  const legal = crawl.legalElements
    .map((e) => `- ${e.label}: ${e.present ? "PRESENT" : "MISSING"} (severity if missing: ${e.severity})`)
    .join("\n");

  const footerLinks = crawl.links
    .filter((l) => l.inFooter)
    .slice(0, 40)
    .map((l) => `- ${l.text || "(no text)"} -> ${l.href}`)
    .join("\n");

  const headings = crawl.headings
    .slice(0, 30)
    .map((h) => `${"#".repeat(h.level)} ${h.text}`)
    .join("\n");

  return [
    `# Landing Page Under Audit`,
    `Requested URL: ${crawl.requestedUrl}`,
    `Final URL: ${crawl.finalUrl}`,
    `HTTP status: ${crawl.statusCode ?? "unknown"}`,
    ``,
    `## Metadata`,
    `Title: ${crawl.metadata.title ?? "(none)"}`,
    `Description: ${crawl.metadata.description ?? "(none)"}`,
    `Lang: ${crawl.metadata.lang ?? "(none)"}`,
    `OG Title: ${crawl.metadata.openGraph.title ?? "(none)"}`,
    `OG Description: ${crawl.metadata.openGraph.description ?? "(none)"}`,
    ``,
    `## Deterministic Legal-Element Check`,
    legal || "(none evaluated)",
    ``,
    `## Headings`,
    headings || "(none)",
    ``,
    `## Footer Links`,
    footerLinks || "(none)",
    ``,
    `## Structural Signals`,
    `Image count: ${crawl.imageCount}`,
    `Form count: ${crawl.formCount}`,
    `Body text length: ${crawl.textLength} chars`,
    ``,
    `## Visible Page Text`,
    text,
    ``,
    `Now audit this landing page and return ONLY the JSON object described in your instructions.`,
  ].join("\n");
}

/**
 * Strip markdown code fences and, as a last resort, extract the first balanced
 * top-level JSON object from arbitrary model text.
 */
export function extractJsonObject(raw: string): string {
  let s = raw.trim();

  // Remove ```json ... ``` or ``` ... ``` fences.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    s = fence[1].trim();
  }

  if (s.startsWith("{") && s.endsWith("}")) {
    return s;
  }

  // Scan for the first balanced object, respecting strings/escapes.
  const start = s.indexOf("{");
  if (start === -1) {
    throw new LpAuditError("LLM_BAD_JSON", "No JSON object found in model response.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }

  throw new LpAuditError("LLM_BAD_JSON", "Unbalanced JSON object in model response.");
}

/** Clamp a number into [min, max], coercing non-finite values to `fallback`. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Coerce an unknown value into one of the allowed severities. */
function coerceSeverity(value: unknown): Severity {
  return SEVERITIES.includes(value as Severity) ? (value as Severity) : "medium";
}

/** Derive the qualitative risk band from the numeric score. */
export function deriveRiskLevel(score: number): AuditReport["riskLevel"] {
  if (score >= 80) return "severe";
  if (score >= 60) return "high";
  if (score >= 40) return "moderate";
  if (score >= 20) return "low";
  return "minimal";
}

/** Coerce an arbitrary value into a string array. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : String(v ?? "").trim()))
    .filter((v) => v.length > 0);
}

/** Coerce a violation's platform tags into the allowed set. */
function coercePlatforms(value: unknown): Platform[] {
  if (!Array.isArray(value)) return [];
  const out: Platform[] = [];
  for (const v of value) {
    const tag = String(v ?? "").toLowerCase().trim();
    if ((PLATFORMS as ReadonlyArray<string>).includes(tag) && !out.includes(tag as Platform)) {
      out.push(tag as Platform);
    }
  }
  return out;
}

/**
 * Validate and normalize the parsed JSON into a strict {@link AuditReport}.
 * Every field is coerced so a partially-malformed reply still yields a usable
 * report rather than throwing.
 */
export function normalizeReport(parsed: unknown): AuditReport {
  if (typeof parsed !== "object" || parsed === null) {
    throw new LpAuditError("LLM_BAD_JSON", "Model response was not a JSON object.");
  }
  const obj = parsed as Record<string, unknown>;

  const riskScore = clampInt(obj["riskScore"], 1, 100, 50);

  const rawViolations = Array.isArray(obj["violations"]) ? obj["violations"] : [];
  const violations: Violation[] = rawViolations.map((item): Violation => {
    const v = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    return {
      category: typeof v["category"] === "string" && v["category"].trim() ? v["category"].trim() : "uncategorized",
      platform: coercePlatforms(v["platform"]),
      severity: coerceSeverity(v["severity"]),
      quote: typeof v["quote"] === "string" ? v["quote"] : "",
      explanation: typeof v["explanation"] === "string" ? v["explanation"] : "",
      suggestion: typeof v["suggestion"] === "string" ? v["suggestion"] : "",
    };
  });

  // Order violations most-to-least severe for presentation.
  const severityRank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  violations.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  const levelFromModel = obj["riskLevel"];
  const validLevels: ReadonlyArray<AuditReport["riskLevel"]> = [
    "minimal",
    "low",
    "moderate",
    "high",
    "severe",
  ];
  const riskLevel = validLevels.includes(levelFromModel as AuditReport["riskLevel"])
    ? (levelFromModel as AuditReport["riskLevel"])
    : deriveRiskLevel(riskScore);

  return {
    riskScore,
    riskLevel,
    summary: typeof obj["summary"] === "string" ? obj["summary"].trim() : "No summary provided by the model.",
    violations,
    detectedCategories: toStringArray(obj["detectedCategories"]),
    recommendations: toStringArray(obj["recommendations"]),
  };
}

/**
 * Call the OpenAI Chat Completions API and return the raw assistant text.
 */
async function callOpenAi(config: JudgeConfig, userPrompt: string): Promise<string> {
  const base = config.baseUrl ?? OPENAI_DEFAULT_BASE;
  const url = `${base.replace(/\/+$/, "")}/chat/completions`;

  const response = await axios.post(
    url,
    {
      model: config.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    },
    {
      timeout: config.requestTimeoutMs,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
    },
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new LpAuditError("LLM_EMPTY", "OpenAI returned an empty completion.");
  }
  return content;
}

/**
 * Call the Google Gemini generateContent API and return the raw model text.
 */
async function callGemini(config: JudgeConfig, userPrompt: string): Promise<string> {
  const base = config.baseUrl ?? GEMINI_DEFAULT_BASE;
  const url =
    `${base.replace(/\/+$/, "")}/models/${encodeURIComponent(config.model)}:generateContent` +
    `?key=${encodeURIComponent(config.apiKey)}`;

  const response = await axios.post(
    url,
    {
      systemInstruction: {
        role: "system",
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    },
    {
      timeout: config.requestTimeoutMs,
      headers: { "Content-Type": "application/json" },
    },
  );

  const parts = response.data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p: { text?: string }) => p?.text ?? "").join("")
    : undefined;

  if (typeof text !== "string" || text.trim().length === 0) {
    throw new LpAuditError("LLM_EMPTY", "Gemini returned an empty response.");
  }
  return text;
}

/**
 * Convert an axios error into a typed, user-friendly LpAuditError.
 */
function wrapHttpError(provider: string, error: unknown): LpAuditError {
  if (axios.isAxiosError(error)) {
    const axErr = error as AxiosError<{ error?: { message?: string } }>;
    const status = axErr.response?.status;
    const apiMessage =
      axErr.response?.data?.error?.message ??
      (typeof axErr.response?.data === "string" ? axErr.response.data : undefined);

    if (status === 401 || status === 403) {
      return new LpAuditError(
        "LLM_AUTH",
        `${provider} rejected the API key (HTTP ${status}). Check your credentials.`,
        error,
      );
    }
    if (status === 429) {
      return new LpAuditError("LLM_RATE_LIMIT", `${provider} rate limit hit (HTTP 429). Retry later.`, error);
    }
    if (axErr.code === "ECONNABORTED") {
      return new LpAuditError("LLM_TIMEOUT", `${provider} request timed out.`, error);
    }
    return new LpAuditError(
      "LLM_HTTP",
      `${provider} request failed${status ? ` (HTTP ${status})` : ""}${apiMessage ? `: ${apiMessage}` : ""}.`,
      error,
    );
  }
  return new LpAuditError(
    "LLM_UNKNOWN",
    `Unexpected error calling ${provider}: ${error instanceof Error ? error.message : String(error)}`,
    error,
  );
}

/**
 * Audit a crawled landing page with the configured LLM and return a validated
 * {@link AuditReport}.
 *
 * @throws {LpAuditError} on auth/network/parse failures.
 */
export async function judge(crawl: CrawlResult, config: JudgeConfig): Promise<AuditReport> {
  const log = (msg: string): void => {
    if (config.verbose) process.stderr.write(`[judge] ${msg}\n`);
  };

  const userPrompt = buildUserPrompt(crawl);
  log(`dispatching to ${config.provider}/${config.model} (${userPrompt.length} prompt chars)`);

  let raw: string;
  try {
    raw = config.provider === "openai" ? await callOpenAi(config, userPrompt) : await callGemini(config, userPrompt);
  } catch (error) {
    if (error instanceof LpAuditError) throw error;
    throw wrapHttpError(config.provider, error);
  }

  log("parsing model response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch (error) {
    if (error instanceof LpAuditError) throw error;
    throw new LpAuditError(
      "LLM_BAD_JSON",
      `Failed to parse model response as JSON: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  const report = normalizeReport(parsed);
  log(`audit complete: riskScore=${report.riskScore} (${report.riskLevel}), ${report.violations.length} violations`);
  return report;
}
