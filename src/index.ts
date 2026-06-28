#!/usr/bin/env node
/**
 * index.ts
 * ---------------------------------------------------------------------------
 * LPAudit CLI entry point.
 *
 * Flow:
 *   1. Parse + validate CLI options with Commander.
 *   2. Resolve the LLM provider/model/API key from flags + environment.
 *   3. Crawl the target LP with Playwright (src/crawler.ts).
 *   4. Audit the extracted content with the LLM judge (src/judge.ts).
 *   5. Render a beautiful, colorized terminal report (or raw JSON with --json).
 *
 * Exit codes:
 *   0  audit completed (regardless of risk level)
 *   1  fatal error (bad input, crawl/judge failure, missing key)
 *   2  audit completed AND riskScore >= --fail-over threshold (CI gate)
 * ---------------------------------------------------------------------------
 */

import { Command, InvalidArgumentError } from "commander";
import * as dotenv from "dotenv";
import {
  bold,
  dim,
  italic,
  underline,
  cyan,
  green,
  greenBright,
  yellow,
  yellowBright,
  red,
  redBright,
  magenta,
  blue,
  gray,
  white,
  bgGreen,
  bgYellow,
  bgRed,
  black,
} from "colorette";
import { promises as fs } from "node:fs";

import { crawl } from "./crawler.js";
import { judge } from "./judge.js";
import {
  type AuditReport,
  type CliOptions,
  type CrawlResult,
  type JudgeConfig,
  type LlmProvider,
  type Severity,
  type Violation,
  LpAuditError,
} from "./types.js";

// Load .env from cwd as early as possible.
dotenv.config();

const VERSION = "1.0.0";

/**
 * Validate that a string is a well-formed http(s) URL. Used as a Commander
 * argument coercer so bad input fails fast with a friendly message.
 */
function parseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidArgumentError("Not a valid URL. Include the scheme, e.g. https://example.com/lp");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidArgumentError(`Unsupported protocol "${parsed.protocol}". Use http or https.`);
  }
  return parsed.toString();
}

/**
 * Commander integer coercer with bounds checking.
 */
function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("Expected a positive integer.");
  }
  return n;
}

/**
 * Validate provider value.
 */
function parseProvider(value: string): LlmProvider {
  const v = value.toLowerCase().trim();
  if (v !== "openai" && v !== "gemini") {
    throw new InvalidArgumentError('Provider must be "openai" or "gemini".');
  }
  return v;
}

/**
 * Resolve the JudgeConfig from validated CLI options + environment variables.
 * Throws a friendly LpAuditError when the required API key is absent.
 */
function resolveJudgeConfig(options: CliOptions): JudgeConfig {
  const apiKey =
    options.provider === "openai"
      ? process.env["OPENAI_API_KEY"]
      : process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"];

  if (!apiKey || apiKey.trim().length === 0) {
    const varName = options.provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
    throw new LpAuditError(
      "MISSING_API_KEY",
      `Environment variable ${varName} is not set. Add it to your shell or a .env file.`,
    );
  }

  const baseUrl =
    options.provider === "openai" ? process.env["OPENAI_BASE_URL"] : process.env["GEMINI_BASE_URL"];

  return {
    provider: options.provider,
    model: options.model,
    apiKey: apiKey.trim(),
    ...(baseUrl && baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}),
    requestTimeoutMs: Math.max(options.timeout, 30_000),
    verbose: options.verbose,
  };
}

/* -------------------------------------------------------------------------- */
/*  Presentation helpers                                                       */
/* -------------------------------------------------------------------------- */

const SEVERITY_META: Record<Severity, { label: string; color: (s: string) => string; icon: string }> = {
  critical: { label: "CRITICAL", color: (s) => redBright(bold(s)), icon: "■" },
  high: { label: "HIGH", color: (s) => red(s), icon: "▲" },
  medium: { label: "MEDIUM", color: (s) => yellow(s), icon: "◆" },
  low: { label: "LOW", color: (s) => blue(s), icon: "●" },
  info: { label: "INFO", color: (s) => gray(s), icon: "·" },
};

/** Colorize a numeric risk score by band. */
function colorizeScore(score: number): string {
  const text = ` ${score}/100 `;
  if (score >= 80) return bgRed(white(bold(text)));
  if (score >= 60) return bgRed(black(bold(text)));
  if (score >= 40) return bgYellow(black(bold(text)));
  if (score >= 20) return bgYellow(black(text));
  return bgGreen(black(bold(text)));
}

/** Colorize the qualitative risk level. */
function colorizeLevel(level: AuditReport["riskLevel"]): string {
  switch (level) {
    case "severe":
      return redBright(bold(level.toUpperCase()));
    case "high":
      return red(bold(level.toUpperCase()));
    case "moderate":
      return yellowBright(bold(level.toUpperCase()));
    case "low":
      return yellow(level.toUpperCase());
    case "minimal":
      return greenBright(bold(level.toUpperCase()));
    default:
      return level;
  }
}

/** Draw a horizontal rule sized to the terminal (clamped). */
function rule(char = "─"): string {
  const width = Math.min(process.stdout.columns ?? 80, 80);
  return dim(char.repeat(width));
}

/** Render an ASCII progress bar for the risk score. */
function riskBar(score: number): string {
  const width = 40;
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  if (score >= 80) return redBright(bar);
  if (score >= 60) return red(bar);
  if (score >= 40) return yellow(bar);
  if (score >= 20) return yellowBright(bar);
  return green(bar);
}

/** Word-wrap a string to a given width with a hanging indent. */
function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length + 1 > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current.length === 0 ? word : `${current} ${word}`;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
}

const PLATFORM_BADGE: Record<string, string> = {
  meta: bgRed(white(" Meta ")),
  google: bgYellow(black(" Google ")),
  tiktok: white(bold(" TikTok ")),
  legal: magenta(bold(" Legal ")),
};

/**
 * Render the full colorized report to stdout.
 */
function renderReport(crawlResult: CrawlResult, report: AuditReport): void {
  const out = process.stdout;
  const write = (s = ""): void => {
    out.write(`${s}\n`);
  };

  write();
  write(rule("━"));
  write(`${bold(cyan("  LPAudit"))} ${dim("— Ad-Compliance & Account-Ban Risk Report")}`);
  write(rule("━"));
  write();

  // Target summary
  write(`${dim("Target URL   :")} ${underline(crawlResult.requestedUrl)}`);
  if (crawlResult.finalUrl !== crawlResult.requestedUrl) {
    write(`${dim("Final URL    :")} ${underline(crawlResult.finalUrl)}`);
  }
  write(`${dim("HTTP status  :")} ${String(crawlResult.statusCode ?? "unknown")}`);
  write(`${dim("Page title   :")} ${crawlResult.metadata.title ?? gray("(none)")}`);
  write(
    `${dim("Signals      :")} ${crawlResult.textLength} chars · ` +
      `${crawlResult.imageCount} images · ${crawlResult.formCount} forms · ` +
      `${crawlResult.links.length} links`,
  );
  write(`${dim("Crawl time   :")} ${crawlResult.crawlDurationMs} ms`);
  if (crawlResult.screenshotPath) {
    write(`${dim("Screenshot   :")} ${crawlResult.screenshotPath}`);
  }
  write();

  // Headline score
  write(rule());
  write(`  ${bold("OVERALL RISK")}   ${colorizeScore(report.riskScore)}   ${colorizeLevel(report.riskLevel)}`);
  write(`  ${riskBar(report.riskScore)}`);
  write(rule());
  write();

  // Executive summary
  write(`${bold("Summary")}`);
  write(`  ${wrap(report.summary, 74, "  ")}`);
  write();

  // Detected sensitive categories
  if (report.detectedCategories.length > 0) {
    write(`${bold("Detected Sensitive Verticals")}`);
    write(`  ${report.detectedCategories.map((c) => magenta(`[${c}]`)).join(" ")}`);
    write();
  }

  // Deterministic legal-element checklist
  write(`${bold("Required Legal Elements")}`);
  for (const el of crawlResult.legalElements) {
    const mark = el.present ? green("✔") : red("✘");
    const status = el.present ? green("present") : red(`MISSING (${el.severity})`);
    write(`  ${mark} ${el.label}`);
    write(`      ${dim(el.present ? el.evidence ?? "" : "not detected on page")} ${dim("→")} ${status}`);
  }
  write();

  // Violations
  write(`${bold(`Policy Violations (${report.violations.length})`)}`);
  write();
  if (report.violations.length === 0) {
    write(`  ${green("No policy violations detected by the model. 🎉")}`);
    write();
  } else {
    report.violations.forEach((v: Violation, i: number) => {
      const meta = SEVERITY_META[v.severity];
      const badges = v.platform.map((p) => PLATFORM_BADGE[p] ?? gray(` ${p} `)).join(" ");
      write(
        `  ${dim(`#${String(i + 1).padStart(2, "0")}`)} ${meta.color(`${meta.icon} ${meta.label}`)} ` +
          `${dim("·")} ${cyan(v.category)} ${badges}`,
      );
      if (v.quote.trim().length > 0) {
        write(`      ${dim("quote :")} ${italic(yellow(`“${truncate(v.quote, 160)}”`))}`);
      }
      write(`      ${dim("why   :")} ${wrap(v.explanation, 66, "              ")}`);
      write(`      ${dim("fix   :")} ${greenBright(wrap(v.suggestion, 66, "              "))}`);
      write();
    });
  }

  // Recommendations
  if (report.recommendations.length > 0) {
    write(`${bold("Prioritized Recommendations")}`);
    report.recommendations.forEach((r, i) => {
      write(`  ${cyan(`${i + 1}.`)} ${wrap(r, 72, "     ")}`);
    });
    write();
  }

  write(rule("━"));
  const verdict =
    report.riskScore >= 60
      ? redBright(bold("⛔  HIGH BAN/REJECTION RISK — fix critical issues before running ads."))
      : report.riskScore >= 40
        ? yellowBright(bold("⚠️   MODERATE RISK — review flagged items before scaling spend."))
        : greenBright(bold("✅  LOW RISK — looks broadly compliant, keep monitoring."));
  write(`  ${verdict}`);
  write(rule("━"));
  write();
}

/** Truncate a string to a max length with an ellipsis. */
function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

async function run(options: CliOptions): Promise<number> {
  const err = (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  };

  // 1. Resolve LLM config up-front so we fail fast on a missing key BEFORE
  //    spending time launching a browser.
  const judgeConfig = resolveJudgeConfig(options);

  // 2. Crawl.
  if (!options.json) {
    err(dim(`→ crawling ${options.url} …`));
  }
  const crawlResult = await crawl({
    url: options.url,
    timeout: options.timeout,
    headful: options.headful,
    screenshot: options.screenshot,
    verbose: options.verbose,
  });

  if (crawlResult.textLength < 40) {
    err(
      yellow(
        "⚠️  Very little text was extracted — the page may be bot-blocked, " +
          "behind a consent wall, or rendered entirely as images. Results may be unreliable.",
      ),
    );
  }

  // 3. Judge.
  if (!options.json) {
    err(dim(`→ auditing with ${judgeConfig.provider}/${judgeConfig.model} …`));
  }
  const report = await judge(crawlResult, judgeConfig);

  // 4. Optionally persist raw JSON.
  if (options.outputJson) {
    const payload = JSON.stringify({ crawl: redactCrawl(crawlResult), report }, null, 2);
    await fs.writeFile(options.outputJson, payload, "utf8");
    if (!options.json) err(dim(`→ wrote JSON report to ${options.outputJson}`));
  }

  // 5. Render.
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ crawl: redactCrawl(crawlResult), report }, null, 2)}\n`);
  } else {
    renderReport(crawlResult, report);
  }

  // CI gate exit code.
  return report.riskScore >= FAIL_OVER_THRESHOLD ? 2 : 0;
}

/**
 * Strip the bulky raw innerText from a CrawlResult for JSON output, keeping the
 * structured signals that matter for downstream tooling.
 */
function redactCrawl(crawlResult: CrawlResult): Omit<CrawlResult, "innerText"> & { innerText: string } {
  return {
    ...crawlResult,
    innerText:
      crawlResult.innerText.length > 2_000
        ? `${crawlResult.innerText.slice(0, 2_000)}…[truncated]`
        : crawlResult.innerText,
  };
}

/**
 * The risk score at/above which the process exits with code 2, so the tool can
 * gate a CI pipeline. Overridable via LPAUDIT_FAIL_OVER.
 */
const FAIL_OVER_THRESHOLD = (() => {
  const raw = process.env["LPAUDIT_FAIL_OVER"];
  const n = raw ? Number(raw) : 60;
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 60;
})();

function buildProgram(): Command {
  const program = new Command();

  program
    .name("lpaudit")
    .description(
      "Audit an advertising landing page for ad-platform rejection & account-ban risk " +
        "(Meta / Google / TikTok) using Playwright crawling + LLM policy judgement.",
    )
    .version(VERSION, "-V, --version", "output the version number")
    .requiredOption("-u, --url <url>", "landing-page URL to audit (http/https)", parseUrl)
    .option("-p, --provider <provider>", 'LLM provider: "openai" or "gemini"', parseProvider)
    .option("-m, --model <model>", "model id (defaults per provider)")
    .option("-t, --timeout <ms>", "navigation/render timeout in ms", parsePositiveInt, 45_000)
    .option("--headful", "run the browser with a visible window", false)
    .option("--screenshot", "capture and save a full-page screenshot", false)
    .option("--json", "emit machine-readable JSON only (no colored report)", false)
    .option("-o, --output-json <file>", "also write the full raw JSON report to a file")
    .option("-v, --verbose", "verbose diagnostic logging to stderr", false)
    .addHelpText(
      "after",
      [
        "",
        "Environment:",
        "  OPENAI_API_KEY     required when --provider openai",
        "  GEMINI_API_KEY     required when --provider gemini",
        "  LPAUDIT_PROVIDER   default provider when --provider is omitted",
        "  LPAUDIT_MODEL      default model when --model is omitted",
        "  LPAUDIT_FAIL_OVER  riskScore at/above which exit code is 2 (default 60)",
        "",
        "Examples:",
        '  lpaudit --url "https://example.com/lp"',
        '  lpaudit -u https://example.com/lp -p gemini -m gemini-1.5-flash --screenshot',
        '  lpaudit -u https://example.com/lp --json -o report.json',
      ].join("\n"),
    );

  return program;
}

/**
 * Normalize the raw Commander options object into a strict CliOptions, applying
 * environment-variable defaults for provider/model.
 */
function normalizeOptions(raw: Record<string, unknown>): CliOptions {
  const provider: LlmProvider =
    (raw["provider"] as LlmProvider | undefined) ??
    ((process.env["LPAUDIT_PROVIDER"]?.toLowerCase() === "gemini" ? "gemini" : undefined) as
      | LlmProvider
      | undefined) ??
    "openai";

  const defaultModel = provider === "openai" ? "gpt-4o-mini" : "gemini-1.5-flash";
  const model =
    (typeof raw["model"] === "string" && raw["model"].trim().length > 0 ? (raw["model"] as string) : undefined) ??
    (process.env["LPAUDIT_MODEL"] && process.env["LPAUDIT_MODEL"].trim().length > 0
      ? process.env["LPAUDIT_MODEL"].trim()
      : undefined) ??
    defaultModel;

  return {
    url: raw["url"] as string,
    provider,
    model,
    timeout: raw["timeout"] as number,
    headful: Boolean(raw["headful"]),
    screenshot: Boolean(raw["screenshot"]),
    json: Boolean(raw["json"]),
    verbose: Boolean(raw["verbose"]),
    ...(typeof raw["outputJson"] === "string" ? { outputJson: raw["outputJson"] as string } : {}),
  };
}

async function main(): Promise<void> {
  const program = buildProgram();

  // Commander throws/exits on its own for arg errors; catch our domain errors.
  program.parse(process.argv);
  const options = normalizeOptions(program.opts());

  try {
    const code = await run(options);
    process.exitCode = code;
  } catch (error) {
    if (error instanceof LpAuditError) {
      process.stderr.write(`${redBright(bold("✖ LPAudit error"))} ${dim(`[${error.code}]`)} ${error.message}\n`);
      if (options.verbose && error.cause instanceof Error) {
        process.stderr.write(dim(`${error.cause.stack ?? error.cause.message}\n`));
      }
    } else {
      process.stderr.write(`${redBright(bold("✖ Unexpected error"))} ${error instanceof Error ? error.message : String(error)}\n`);
      if (options.verbose && error instanceof Error) {
        process.stderr.write(dim(`${error.stack ?? ""}\n`));
      }
    }
    process.exitCode = 1;
  }
}

// Guard against unhandled rejections so we always exit cleanly.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`${redBright(bold("✖ Unhandled rejection"))} ${String(reason)}\n`);
  process.exitCode = 1;
});

void main();
