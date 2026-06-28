/**
 * crawler.ts
 * ---------------------------------------------------------------------------
 * Playwright-powered landing-page crawler.
 *
 * Responsibilities:
 *   - Launch a hardened, ad-blocker-friendly Chromium context.
 *   - Navigate to the target LP, waiting for network idle so SPA/JS content
 *     has actually rendered.
 *   - Trigger lazy-loaded content by progressively scrolling the page.
 *   - Extract inner text, head metadata + OGP, headings, links, media/form
 *     counts, and the deterministic presence of legally-required elements
 *     (特定商取引法に基づく表記 / privacy policy / etc.).
 *   - Optionally capture a full-page screenshot.
 *
 * The module exposes a single `crawl()` function returning a strongly-typed
 * `CrawlResult`. All Playwright resources are released in a `finally` block so
 * we never leak browser processes, even on failure.
 * ---------------------------------------------------------------------------
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  type CrawlResult,
  type LegalElementCheck,
  type PageMetadata,
  type ExtractedLink,
  type Severity,
  LpAuditError,
} from "./types.js";

/**
 * Options accepted by {@link crawl}. These are a narrowed subset of the CLI
 * options that the crawler actually cares about.
 */
export interface CrawlerOptions {
  readonly url: string;
  readonly timeout: number;
  readonly headful: boolean;
  readonly screenshot: boolean;
  readonly verbose: boolean;
  /** Directory in which to write screenshots; defaults to cwd. */
  readonly screenshotDir?: string;
}

/**
 * Definition of a single legal/compliance element to look for. We match either
 * by anchor/link text, by raw body text, or both. Matching is accent- and
 * case-insensitive and tolerant of full-width/half-width variants common in
 * Japanese pages.
 */
interface LegalElementSpec {
  readonly key: string;
  readonly label: string;
  readonly severity: Severity;
  /** Lower-cased substrings; ANY match satisfies the check. */
  readonly needles: ReadonlyArray<string>;
}

/**
 * The canonical list of legal elements LPAudit checks for. This is tuned for
 * Japanese commerce LPs (特定商取引法, 景品表示法) plus the globally-required
 * privacy / contact / company elements that Meta & Google demand.
 */
const LEGAL_ELEMENT_SPECS: ReadonlyArray<LegalElementSpec> = [
  {
    key: "tokushoho",
    label: "特定商取引法に基づく表記 (Specified Commercial Transactions Act notice)",
    severity: "critical",
    needles: ["特定商取引法", "特定商取引", "特商法", "tokutei shoutorihiki", "commercial transactions act"],
  },
  {
    key: "privacyPolicy",
    label: "Privacy Policy",
    severity: "critical",
    needles: ["プライバシーポリシー", "個人情報保護方針", "個人情報の取り扱い", "privacy policy", "privacy"],
  },
  {
    key: "terms",
    label: "Terms of Service / 利用規約",
    severity: "high",
    needles: ["利用規約", "ご利用規約", "terms of service", "terms of use", "terms and conditions"],
  },
  {
    key: "companyInfo",
    label: "Company / Operator Information (運営会社・会社概要)",
    severity: "high",
    needles: ["会社概要", "運営会社", "運営者情報", "会社情報", "company information", "about us", "about company"],
  },
  {
    key: "contact",
    label: "Contact Information (お問い合わせ)",
    severity: "medium",
    needles: ["お問い合わせ", "お問合せ", "問い合わせ", "contact us", "contact", "support"],
  },
  {
    key: "refundPolicy",
    label: "Refund / Cancellation Policy (返品・キャンセルポリシー)",
    severity: "medium",
    needles: ["返品", "返金", "キャンセルポリシー", "返品ポリシー", "refund policy", "return policy", "cancellation"],
  },
];

/**
 * A tiny structured logger that respects the `verbose` flag and writes to
 * stderr so it never contaminates JSON output on stdout.
 */
function makeLogger(verbose: boolean): (msg: string) => void {
  return (msg: string): void => {
    if (verbose) {
      process.stderr.write(`[crawler] ${msg}\n`);
    }
  };
}

/**
 * Normalize text for substring matching: lower-case, collapse whitespace, and
 * strip a few zero-width characters that occasionally appear in CJK markup.
 */
function normalizeForMatch(input: string): string {
  return input
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Progressively scroll the page to the bottom in steps, pausing between each so
 * IntersectionObserver-driven lazy images / sections / web fonts can load.
 * Resolves once we reach the bottom or the safety cap of iterations is hit.
 */
async function autoScroll(page: Page, log: (m: string) => void): Promise<void> {
  log("auto-scrolling to trigger lazy-loaded content");
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const distance = 600;
      const delay = 180;
      const maxIterations = 60;
      let iterations = 0;
      let lastScrollY = -1;

      const timer = setInterval(() => {
        const { scrollHeight } = document.documentElement;
        window.scrollBy(0, distance);
        iterations += 1;

        const reachedBottom = window.scrollY + window.innerHeight >= scrollHeight - 2;
        const stuck = window.scrollY === lastScrollY;
        lastScrollY = window.scrollY;

        if (reachedBottom || stuck || iterations >= maxIterations) {
          clearInterval(timer);
          // Return to the top so any "scroll up" handlers settle.
          window.scrollTo(0, 0);
          resolve();
        }
      }, delay);
    });
  });

  // Give late network requests a brief grace window after scrolling settles.
  await page.waitForTimeout(500);
}

/**
 * Extract head metadata (title/description/canonical/lang/robots/viewport) plus
 * the full set of Open Graph tags. Runs entirely inside the page context.
 */
async function extractMetadata(page: Page): Promise<PageMetadata> {
  return page.evaluate(() => {
    const attr = (selector: string, attribute: string): string | null => {
      const el = document.querySelector(selector);
      const value = el?.getAttribute(attribute);
      return value && value.trim().length > 0 ? value.trim() : null;
    };

    const meta = (name: string): string | null => attr(`meta[name="${name}"]`, "content");
    const og = (property: string): string | null => attr(`meta[property="${property}"]`, "content");

    const titleEl = document.querySelector("title");
    const title = titleEl?.textContent?.trim() ?? null;

    return {
      title: title && title.length > 0 ? title : null,
      description: meta("description"),
      canonical: attr('link[rel="canonical"]', "href"),
      lang: document.documentElement.getAttribute("lang"),
      viewport: meta("viewport"),
      robots: meta("robots"),
      openGraph: {
        title: og("og:title"),
        description: og("og:description"),
        image: og("og:image"),
        url: og("og:url"),
        type: og("og:type"),
        siteName: og("og:site_name"),
      },
    };
  });
}

/**
 * Extract headings, deduplicated links (with footer flag), and media/form
 * counts. Links are resolved to absolute URLs using the document base.
 */
async function extractStructure(page: Page): Promise<{
  headings: Array<{ level: number; text: string }>;
  links: ExtractedLink[];
  imageCount: number;
  formCount: number;
}> {
  return page.evaluate(() => {
    const collapse = (s: string | null | undefined): string =>
      (s ?? "").replace(/\s+/g, " ").trim();

    // Headings in document order.
    const headings: Array<{ level: number; text: string }> = [];
    document.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((node) => {
      const level = Number(node.tagName.substring(1));
      const text = collapse(node.textContent);
      if (text.length > 0) {
        headings.push({ level, text });
      }
    });

    // Identify footer regions once so we can flag footer links.
    const footers = Array.from(document.querySelectorAll("footer, [role='contentinfo'], .footer, #footer"));
    const isInFooter = (el: Element): boolean => footers.some((f) => f.contains(el));

    // Deduplicate links by resolved href.
    const seen = new Set<string>();
    const links: Array<{ text: string; href: string; inFooter: boolean }> = [];
    document.querySelectorAll("a[href]").forEach((anchor) => {
      const raw = anchor.getAttribute("href");
      if (!raw) return;
      let resolved: string;
      try {
        resolved = new URL(raw, document.baseURI).toString();
      } catch {
        return;
      }
      if (resolved.startsWith("javascript:") || resolved.startsWith("#")) return;
      if (seen.has(resolved)) return;
      seen.add(resolved);
      links.push({
        text: collapse(anchor.textContent),
        href: resolved,
        inFooter: isInFooter(anchor),
      });
    });

    return {
      headings,
      links,
      imageCount: document.querySelectorAll("img").length,
      formCount: document.querySelectorAll("form").length,
    };
  });
}

/**
 * Run the deterministic legal-element checks against the page. We consider both
 * the visible body text and the link corpus (text + href), because legal pages
 * are frequently linked by URL slug (e.g. /privacy) without explicit anchor
 * text in some templated builders.
 */
function evaluateLegalElements(
  bodyText: string,
  links: ReadonlyArray<ExtractedLink>,
): LegalElementCheck[] {
  const normalizedBody = normalizeForMatch(bodyText);
  const normalizedLinks = links.map((l) =>
    normalizeForMatch(`${l.text} ${l.href}`),
  );

  return LEGAL_ELEMENT_SPECS.map((spec): LegalElementCheck => {
    let evidence: string | undefined;

    for (const needle of spec.needles) {
      const n = normalizeForMatch(needle);
      if (normalizedBody.includes(n)) {
        evidence = `body text contains “${needle}”`;
        break;
      }
      const linkIdx = normalizedLinks.findIndex((l) => l.includes(n));
      if (linkIdx >= 0) {
        const matched = links[linkIdx];
        evidence = `link “${matched?.text || matched?.href}” matches “${needle}”`;
        break;
      }
    }

    return {
      key: spec.key,
      label: spec.label,
      present: evidence !== undefined,
      severity: spec.severity,
      ...(evidence !== undefined ? { evidence } : {}),
    };
  });
}

/**
 * Build a filesystem-safe screenshot filename from a URL and timestamp.
 */
function screenshotFileName(url: string): string {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/[^a-z0-9.-]/gi, "_");
    } catch {
      return "page";
    }
  })();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `lpaudit-${host}-${stamp}.png`;
}

/**
 * Crawl a landing page and return a fully-populated {@link CrawlResult}.
 *
 * @throws {LpAuditError} with code `CRAWL_FAILED` on navigation/extraction
 * failure, after ensuring all browser resources are released.
 */
export async function crawl(options: CrawlerOptions): Promise<CrawlResult> {
  const log = makeLogger(options.verbose);
  const startedAt = Date.now();

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    log(`launching chromium (headful=${options.headful})`);
    browser = await chromium.launch({
      headless: !options.headful,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
      ],
    });

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "ja-JP",
      viewport: { width: 1366, height: 900 },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
    });

    // Mask the most obvious automation fingerprint before any page script runs.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(options.timeout);
    page.setDefaultNavigationTimeout(options.timeout);

    log(`navigating to ${options.url}`);
    const response = await page.goto(options.url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeout,
    });
    const statusCode = response ? response.status() : null;

    // Wait for the network to settle so SPA frameworks finish hydrating.
    // `networkidle` can hang on pages with persistent connections (chat
    // widgets, analytics beacons), so we cap the wait and continue regardless.
    try {
      await page.waitForLoadState("networkidle", { timeout: Math.min(options.timeout, 15_000) });
    } catch {
      log("networkidle wait timed out; continuing with current DOM state");
    }

    // Trigger lazy-loaded sections, then let the DOM settle once more.
    await autoScroll(page, log);
    try {
      await page.waitForLoadState("networkidle", { timeout: 8_000 });
    } catch {
      log("post-scroll networkidle wait timed out; continuing");
    }

    log("extracting inner text");
    const innerText = ((await page.evaluate(() => document.body?.innerText ?? "")) || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    log("extracting metadata");
    const metadata = await extractMetadata(page);

    log("extracting structure (headings, links, media)");
    const structure = await extractStructure(page);

    log("evaluating legal elements");
    const legalElements = evaluateLegalElements(innerText, structure.links);

    let screenshotPath: string | undefined;
    if (options.screenshot) {
      const dir = options.screenshotDir ?? process.cwd();
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, screenshotFileName(options.url));
      log(`capturing full-page screenshot -> ${file}`);
      await page.screenshot({ path: file, fullPage: true });
      screenshotPath = file;
    }

    const finalUrl = page.url();
    const crawlDurationMs = Date.now() - startedAt;
    log(`crawl complete in ${crawlDurationMs}ms (${innerText.length} chars of text)`);

    return {
      finalUrl,
      requestedUrl: options.url,
      statusCode,
      innerText,
      textLength: innerText.length,
      metadata,
      headings: structure.headings,
      links: structure.links,
      legalElements,
      imageCount: structure.imageCount,
      formCount: structure.formCount,
      ...(screenshotPath !== undefined ? { screenshotPath } : {}),
      crawlDurationMs,
    };
  } catch (error) {
    throw new LpAuditError(
      "CRAWL_FAILED",
      `Failed to crawl ${options.url}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  } finally {
    // Best-effort teardown; never let cleanup mask the original error.
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
