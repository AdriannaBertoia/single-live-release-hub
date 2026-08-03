#!/usr/bin/env node

/**
 * Monthly Executive Digest Generator
 *
 * Generates a summary email on the 1st of every month containing:
 * - Past month's shipped releases across both companies
 * - Major upcoming milestones for the next 30 days
 *
 * Usage:
 *   node src/generate-digest.js              # Generate and send
 *   node src/generate-digest.js --preview    # Generate HTML to stdout (no send)
 *   node src/generate-digest.js --month 7    # Generate for a specific month (1-12)
 */

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATA_PATH = path.join(__dirname, '..', 'data', 'releases.json');
const SAMPLE_DATA_PATH = path.join(__dirname, '..', 'data', 'releases.sample.json');
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'digest-email.hbs');
const OUTPUT_DIR = path.join(__dirname, '..', 'dist');

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isPreview = args.includes('--preview');
const monthArgIdx = args.indexOf('--month');
const overrideMonth = monthArgIdx !== -1 ? parseInt(args[monthArgIdx + 1], 10) : null;

// ---------------------------------------------------------------------------
// Date Utilities
// ---------------------------------------------------------------------------

function getDigestPeriod(referenceDate) {
  const now = referenceDate || new Date();

  // The digest covers the previous month
  let year = now.getFullYear();
  let month = overrideMonth || now.getMonth(); // getMonth() is 0-indexed, so current month -1 for "last month"

  // If override month is provided, use it as the month to report on (1-indexed input)
  if (overrideMonth) {
    month = overrideMonth; // 1-indexed: January = 1
  } else {
    // Default: report on previous month
    // If we're on the 1st, the "previous month" is last month
    month = now.getMonth(); // 0-indexed current month = previous month in 1-indexed
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }

  const startOfMonth = new Date(year, month - 1, 1); // month-1 because Date uses 0-indexed
  const endOfMonth = new Date(year, month, 0, 23, 59, 59); // last day of that month

  // Next 30 days from "now" for upcoming milestones
  const upcomingStart = new Date(now);
  const upcomingEnd = new Date(now);
  upcomingEnd.setDate(upcomingEnd.getDate() + 30);

  return {
    reportMonth: startOfMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    start: startOfMonth,
    end: endOfMonth,
    upcomingStart,
    upcomingEnd,
    upcomingLabel: `${upcomingStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${upcomingEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
  };
}

// ---------------------------------------------------------------------------
// Data Processing
// ---------------------------------------------------------------------------

function loadReleases() {
  const dataPath = fs.existsSync(DATA_PATH) ? DATA_PATH : SAMPLE_DATA_PATH;
  if (!fs.existsSync(dataPath)) {
    throw new Error('No release data found. Run `npm run sync` first.');
  }
  const raw = fs.readFileSync(dataPath, 'utf-8');
  return JSON.parse(raw);
}

function buildDigestData(releases, period) {
  // Shipped last month: published releases with releasedAt in the period
  const shipped = releases
    .filter(r => {
      if (r.status !== 'published') return false;
      if (!r.releasedAt && !r.releaseDate) return false;
      const releaseDate = new Date(r.releasedAt || r.releaseDate);
      return releaseDate >= period.start && releaseDate <= period.end;
    })
    .sort((a, b) => {
      const dateA = new Date(a.releasedAt || a.releaseDate);
      const dateB = new Date(b.releasedAt || b.releaseDate);
      return dateA - dateB;
    });

  // Upcoming milestones: upcoming releases with releaseDate in next 30 days
  const upcoming = releases
    .filter(r => {
      if (r.status !== 'upcoming') return false;
      if (!r.releaseDate) return false;
      const releaseDate = new Date(r.releaseDate + 'T00:00:00');
      return releaseDate >= period.upcomingStart && releaseDate <= period.upcomingEnd;
    })
    .sort((a, b) => {
      return new Date(a.releaseDate) - new Date(b.releaseDate);
    });

  // Group shipped by company
  const shippedByCompany = {};
  for (const release of shipped) {
    const company = release.companyName || release.company;
    if (!shippedByCompany[company]) {
      shippedByCompany[company] = [];
    }
    shippedByCompany[company].push(release);
  }

  // Stats
  const totalIssuesShipped = shipped.reduce((sum, r) => sum + (r.issues?.length || 0), 0);
  const featureCount = shipped.reduce((sum, r) =>
    sum + (r.issues?.filter(i => i.type === 'feature').length || 0), 0);
  const bugFixCount = shipped.reduce((sum, r) =>
    sum + (r.issues?.filter(i => i.type === 'bug').length || 0), 0);

  return {
    period,
    generatedAt: new Date().toISOString(),
    stats: {
      totalReleases: shipped.length,
      totalIssues: totalIssuesShipped,
      features: featureCount,
      bugFixes: bugFixCount,
      upcomingCount: upcoming.length
    },
    shipped,
    shippedByCompany: Object.entries(shippedByCompany).map(([company, releases]) => ({
      company,
      releases,
      count: releases.length
    })),
    upcoming,
    hasShipped: shipped.length > 0,
    hasUpcoming: upcoming.length > 0
  };
}

// ---------------------------------------------------------------------------
// Template Rendering
// ---------------------------------------------------------------------------

function registerHelpers() {
  Handlebars.registerHelper('formatDate', function (dateStr) {
    if (!dateStr) return 'TBD';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  });

  Handlebars.registerHelper('shortDate', function (dateStr) {
    if (!dateStr) return 'TBD';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  Handlebars.registerHelper('pluralize', function (count, singular, plural) {
    return count === 1 ? singular : (plural || singular + 's');
  });

  Handlebars.registerHelper('ifGt', function (a, b, options) {
    return a > b ? options.fn(this) : options.inverse(this);
  });

  Handlebars.registerHelper('tagClass', function (tag) {
    const map = { major: 'tag-major', hotfix: 'tag-hotfix', security: 'tag-security' };
    return map[tag] || 'tag-default';
  });
}

function renderDigest(digestData) {
  registerHelpers();

  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Template not found: ${TEMPLATE_PATH}. Create it first.`);
  }

  const templateSrc = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  const template = Handlebars.compile(templateSrc);
  return template(digestData);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function writeDigest(html, period) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const filename = `digest-${period.start.toISOString().slice(0, 7)}.html`;
  const outputPath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(outputPath, html);
  return outputPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log(' Monthly Executive Digest Generator');
  console.log('═══════════════════════════════════════════\n');

  const period = getDigestPeriod();
  console.log(`Report period: ${period.reportMonth}`);
  console.log(`Upcoming window: ${period.upcomingLabel}\n`);

  const data = loadReleases();
  const digestData = buildDigestData(data.releases, period);

  console.log(`Shipped releases: ${digestData.stats.totalReleases}`);
  console.log(`  Features: ${digestData.stats.features}`);
  console.log(`  Bug fixes: ${digestData.stats.bugFixes}`);
  console.log(`  Total issues: ${digestData.stats.totalIssues}`);
  console.log(`Upcoming milestones: ${digestData.stats.upcomingCount}\n`);

  const html = renderDigest(digestData);

  if (isPreview) {
    console.log('───────────────────────────────────────────');
    console.log('PREVIEW MODE — HTML output:\n');
    console.log(html);
  } else {
    const outputPath = writeDigest(html, period);
    console.log(`✓ Digest written to: ${outputPath}`);
    console.log('\nTo send via email, configure SMTP in .env and run:');
    console.log('  node src/send-digest.js');
  }
}

main().catch(err => {
  console.error('✗ Digest generation failed:', err.message);
  process.exit(1);
});
