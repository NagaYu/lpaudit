/**
 * types.ts
 * ---------------------------------------------------------------------------
 * Central, strict type definitions for LPAudit.
 *
 * Three concerns live here:
 *   1. The shape of data extracted from a landing page by the crawler.
 *   2. The shape of the audit report returned by the LLM judge.
 *   3. The shape of validated CLI options.
 *
 * Everything downstream is typed against these contracts, so any change to the
 * data flow surfaces as a compile-time error rather than a runtime surprise.
 * ---------------------------------------------------------------------------
 */

/**
 * Which LLM provider to dispatch the audit to. Selected via the
 * `LPAUDIT_PROVIDER` environment variable or the `--provider` flag.
 */
export type LlmProvider = "openai" | "gemini";

/**
 * Severity buckets used both by the heuristic pre-checks (legal elements) and
 * by the LLM for individual violations.
 */
export type Severity = "critical" | "high" | "medium" | "low" | "info";

/**
 * A single required legal / compliance element and whether it was detected on
 * the page. These are the hard, deterministic checks performed locally before
 * any LLM call (e.g. presence of a privacy policy link).
 */
export interface LegalElementCheck {
  /** Stable machine key, e.g. "privacyPolicy". */
  readonly key: string;
  /** Human-readable label shown in the report, e.g. "Privacy Policy". */
  readonly label: string;
  /** Whether at least one matching link or text token was found. */
  readonly present: boolean;
  /** How damaging the absence is for ad approval. */
  readonly severity: Severity;
  /** The concrete evidence that satisfied the check, if any. */
  readonly evidence?: string;
}

/**
 * Open Graph protocol metadata pulled from `<meta property="og:*">` tags.
 */
export interface OpenGraphMeta {
  readonly title: string | null;
  readonly description: string | null;
  readonly image: string | null;
  readonly url: string | null;
  readonly type: string | null;
  readonly siteName: string | null;
}

/**
 * Page-level metadata extracted from the `<head>`.
 */
export interface PageMetadata {
  readonly title: string | null;
  readonly description: string | null;
  readonly canonical: string | null;
  readonly lang: string | null;
  readonly viewport: string | null;
  readonly robots: string | null;
  readonly openGraph: OpenGraphMeta;
}

/**
 * A single hyperlink discovered on the page (deduplicated by resolved href).
 */
export interface ExtractedLink {
  /** Visible anchor text, trimmed and whitespace-collapsed. */
  readonly text: string;
  /** Absolute, resolved URL. */
  readonly href: string;
  /** Whether the link lives inside a <footer> region. */
  readonly inFooter: boolean;
}

/**
 * The complete, structured payload produced by the crawler for a single LP.
 */
export interface CrawlResult {
  /** The exact URL that was navigated to (after redirects). */
  readonly finalUrl: string;
  /** The URL originally requested by the user. */
  readonly requestedUrl: string;
  /** HTTP status of the main document response, if observable. */
  readonly statusCode: number | null;
  /** Full visible inner text of the rendered <body>. */
  readonly innerText: string;
  /** Character length of innerText (convenience for prompts / reporting). */
  readonly textLength: number;
  /** Parsed head metadata. */
  readonly metadata: PageMetadata;
  /** All headings (h1–h6) in document order. */
  readonly headings: ReadonlyArray<{ readonly level: number; readonly text: string }>;
  /** Deduplicated links, footer links included and flagged. */
  readonly links: ReadonlyArray<ExtractedLink>;
  /** Deterministic legal-element presence checks. */
  readonly legalElements: ReadonlyArray<LegalElementCheck>;
  /** Number of <img> elements (a rough proxy for media-heavy pages). */
  readonly imageCount: number;
  /** Number of <form> elements (lead-gen / data collection signal). */
  readonly formCount: number;
  /** Optional path to a saved full-page screenshot. */
  readonly screenshotPath?: string;
  /** Wall-clock crawl duration in milliseconds. */
  readonly crawlDurationMs: number;
}

/**
 * A single policy violation surfaced by the LLM judge.
 */
export interface Violation {
  /** Stable category key, e.g. "exaggerated_claims", "restricted_health". */
  readonly category: string;
  /** Which ad platform(s) this most directly jeopardizes. */
  readonly platform: ReadonlyArray<"meta" | "google" | "tiktok" | "legal">;
  /** Severity of this specific violation. */
  readonly severity: Severity;
  /** The offending text quoted verbatim from the page (may be empty). */
  readonly quote: string;
  /** Why this is a problem, in plain language. */
  readonly explanation: string;
  /** A concrete, copy-pasteable remediation suggestion. */
  readonly suggestion: string;
}

/**
 * The structured audit report returned by the LLM. This is the canonical JSON
 * contract the model is forced to comply with.
 */
export interface AuditReport {
  /** Overall ban/rejection risk on a 1–100 scale (higher = riskier). */
  readonly riskScore: number;
  /** One of five qualitative bands derived from riskScore. */
  readonly riskLevel: "minimal" | "low" | "moderate" | "high" | "severe";
  /** Two-or-three sentence executive summary. */
  readonly summary: string;
  /** All detected violations, ordered most-to-least severe. */
  readonly violations: ReadonlyArray<Violation>;
  /** Restricted/sensitive verticals the page appears to touch. */
  readonly detectedCategories: ReadonlyArray<string>;
  /** High-level, prioritized remediation steps. */
  readonly recommendations: ReadonlyArray<string>;
}

/**
 * Validated and normalized CLI options after Commander parsing.
 */
export interface CliOptions {
  /** The landing-page URL to audit (validated http/https). */
  readonly url: string;
  /** Which LLM provider to use. */
  readonly provider: LlmProvider;
  /** Concrete model id, e.g. "gpt-4o-mini" or "gemini-1.5-flash". */
  readonly model: string;
  /** Navigation/render timeout in milliseconds. */
  readonly timeout: number;
  /** Whether to run the browser with a visible window. */
  readonly headful: boolean;
  /** Whether to capture and save a full-page screenshot. */
  readonly screenshot: boolean;
  /** If set, write the raw JSON report to this file path. */
  readonly outputJson?: string;
  /** Suppress decorative output; emit machine-readable JSON only. */
  readonly json: boolean;
  /** Emit verbose diagnostic logging to stderr. */
  readonly verbose: boolean;
}

/**
 * Resolved runtime configuration for the judge module, assembled from CLI
 * options plus environment variables.
 */
export interface JudgeConfig {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly apiKey: string;
  /** Optional override for the provider base URL (proxies, gateways). */
  readonly baseUrl?: string;
  readonly requestTimeoutMs: number;
  readonly verbose: boolean;
}

/**
 * A typed error class so callers can distinguish expected operational failures
 * (bad URL, missing key, model returned junk) from unexpected crashes.
 */
export class LpAuditError extends Error {
  public readonly code: string;
  public override readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "LpAuditError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
    // Restore prototype chain for instanceof checks under transpilation.
    Object.setPrototypeOf(this, LpAuditError.prototype);
  }
}
