#!/usr/bin/env node

/**
 * AI-Powered Customer-Facing Release Notes Generator
 *
 * Takes synced Jira data (grouped by Epic) and uses OpenAI to rewrite
 * technical ticket summaries into value-add language for marketing
 * and customer-facing teams.
 *
 * Usage:
 *   node src/generate-release-notes.js                    # Generate for current + last month
 *   node src/generate-release-notes.js --month 2026-08   # Generate for specific month
 *   node src/generate-release-notes.js --all             # Generate for all synced months
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATA_PATH = path.join(__dirname, '..', 'data', 'releases.json');
const SAMPLE_DATA_PATH = path.join(__dirname, '..', 'data', 'releases.sample.json');
const OUTPUT_DIR = path.join(__dirname, '..', 'public', 'release-notes');
const NOTES_CACHE_PATH = path.join(__dirname, '..', 'data', 'release-notes-cache.json');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// ---------------------------------------------------------------------------
// CLI Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const specificMonth = args.find(a => a.match(/^\d{4}-\d{2}$/)) ||
  (args.includes('--month') ? args[args.indexOf('--month') + 1] : null);
const generateAll = args.includes('--all');

// ---------------------------------------------------------------------------
// Data Loading
// ---------------------------------------------------------------------------

function loadReleases() {
  const dataPath = fs.existsSync(DATA_PATH) ? DATA_PATH : SAMPLE_DATA_PATH;
  if (!fs.existsSync(dataPath)) {
    throw new Error('No release data found. Run `npm run sync` first.');
  }
  return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
}

function loadCache() {
  if (fs.existsSync(NOTES_CACHE_PATH)) {
    return JSON.parse(fs.readFileSync(NOTES_CACHE_PATH, 'utf-8'));
  }
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(NOTES_CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ---------------------------------------------------------------------------
// Group releases by month and epic
// ---------------------------------------------------------------------------

function groupByMonth(releases) {
  const groups = {};
  for (const release of releases) {
    if (!release.issues || release.issues.length === 0) continue;
    if (!release.releaseDate) continue;

    const date = new Date(release.releaseDate + 'T00:00:00');
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!groups[key]) {
      groups[key] = {
        key,
        label: date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        companies: {}
      };
    }

    const company = release.companyName;
    if (!groups[key].companies[company]) {
      groups[key].companies[company] = { epics: {}, standalone: [] };
    }

    for (const issue of release.issues) {
      if (issue.epic) {
        const epicKey = issue.epic.key;
        if (!groups[key].companies[company].epics[epicKey]) {
          groups[key].companies[company].epics[epicKey] = {
            key: issue.epic.key,
            summary: issue.epic.summary,
            url: issue.epic.url,
            issues: []
          };
        }
        groups[key].companies[company].epics[epicKey].issues.push(issue);
      } else {
        groups[key].companies[company].standalone.push(issue);
      }
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// OpenAI Integration
// ---------------------------------------------------------------------------

async function generateValueAdd(epicSummary, issues, company) {
  if (!GEMINI_API_KEY) {
    return {
      headline: epicSummary,
      description: `Includes ${issues.length} improvement${issues.length !== 1 ? 's' : ''} to ${epicSummary.toLowerCase()}.`,
      valueAdd: ''
    };
  }

  const issueList = issues.map(i => `- [${i.type}] ${i.summary}`).join('\n');

  const prompt = `You are a product marketing writer for ${company}, an education technology company. 
Given the following Epic and its associated Jira tickets from a software release, write customer-facing release notes.

Epic: "${epicSummary}"
Tickets:
${issueList}

Write in this exact JSON format:
{
  "headline": "A short, benefit-focused headline (max 8 words, no technical jargon)",
  "description": "1-2 sentences explaining what changed and why it matters to teachers, students, or administrators. Focus on the benefit, not the implementation.",
  "valueAdd": "One sentence starting with 'This means...' explaining the real-world impact."
}

Rules:
- Write for teachers, school administrators, and district leaders
- Focus on outcomes (saves time, improves accuracy, easier to use) not features
- Avoid technical language (no "API", "pipeline", "refactor", etc.)
- Be specific about who benefits and how
- Keep it concise and scannable
- Return ONLY valid JSON, nothing else`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`    ⚠ Gemini error: ${response.status} ${text}`);
      return { headline: epicSummary, description: '', valueAdd: '' };
    }

    const data = await response.json();
    const content = data.candidates[0].content.parts[0].text;
    return JSON.parse(content);
  } catch (err) {
    console.error(`    ⚠ AI generation failed for "${epicSummary}": ${err.message}`);
    return { headline: epicSummary, description: '', valueAdd: '' };
  }
}

async function generateStandaloneNotes(issues, company) {
  if (!GEMINI_API_KEY || issues.length === 0) {
    return issues.map(i => ({
      headline: i.summary,
      description: '',
      valueAdd: '',
      type: i.type
    }));
  }

  const issueList = issues.map(i => `- [${i.type}] ${i.summary}`).join('\n');

  const prompt = `You are a product marketing writer for ${company}, an education technology company.
Given these individual tickets from a software release that don't belong to a larger feature Epic, write brief customer-facing notes for each one.

Tickets:
${issueList}

Write a JSON array with one object per ticket in this format:
[
  {
    "original": "the original ticket summary",
    "headline": "Short benefit-focused headline (max 8 words)",
    "description": "One sentence explaining the benefit for teachers/students/admins.",
    "type": "bug|feature|improvement|task"
  }
]

Rules:
- For bug fixes, frame as "Fixed: [what was wrong]" or "Resolved: [issue]"
- For features, focus on what users can now do
- Skip internal/technical items that don't affect end users (return null for those)
- Write for teachers, school administrators, and district leaders
- Return ONLY a valid JSON array, nothing else`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!response.ok) {
      return issues.map(i => ({ headline: i.summary, description: '', valueAdd: '', type: i.type }));
    }

    const data = await response.json();
    const content = JSON.parse(data.candidates[0].content.parts[0].text);
    const items = Array.isArray(content) ? content : (content.items || content.notes || []);
    return items.filter(i => i !== null);
  } catch (err) {
    console.error(`    ⚠ AI generation failed for standalone items: ${err.message}`);
    return issues.map(i => ({ headline: i.summary, description: '', valueAdd: '', type: i.type }));
  }
}

// ---------------------------------------------------------------------------
// HTML Generation
// ---------------------------------------------------------------------------

function generateHTML(monthlyNotes) {
  const months = Object.values(monthlyNotes).sort((a, b) => b.key.localeCompare(a.key));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Release Notes</title>
  <style>
    :root {
      --color-bg: #f8f9fa;
      --color-surface: #ffffff;
      --color-border: #e2e8f0;
      --color-text: #1a202c;
      --color-text-muted: #64748b;
      --color-accent: #4f46e5;
      --color-el: #6366f1;
      --color-laz: #f59e0b;
      --radius: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--color-bg);
      color: var(--color-text);
      line-height: 1.7;
    }
    .header {
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      color: white;
      padding: 2.5rem 2rem;
      text-align: center;
    }
    .header h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.25rem; }
    .header p { opacity: 0.9; font-size: 0.9rem; }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem; }
    .view-tabs {
      display: flex;
      gap: 0.25rem;
      margin-bottom: 2rem;
      padding: 0.25rem;
      background: var(--color-surface);
      border-radius: var(--radius);
      border: 1px solid var(--color-border);
      width: fit-content;
    }
    .view-tab {
      padding: 0.5rem 1rem;
      border: none;
      background: transparent;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      color: var(--color-text-muted);
    }
    .view-tab:hover { color: var(--color-text); }
    .view-tab.active { background: var(--color-accent); color: white; }
    .month-section { margin-bottom: 3rem; }
    .month-title {
      font-size: 1.3rem;
      font-weight: 700;
      margin-bottom: 1.5rem;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid var(--color-accent);
    }
    .company-label {
      display: inline-block;
      padding: 0.2rem 0.6rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      color: white;
      margin-bottom: 1rem;
    }
    .company-label-el { background: var(--color-el); }
    .company-label-laz { background: var(--color-laz); }
    .note-card {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius);
      padding: 1.25rem 1.5rem;
      margin-bottom: 1rem;
    }
    .note-headline {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 0.35rem;
    }
    .note-description {
      font-size: 0.9rem;
      color: var(--color-text);
      margin-bottom: 0.35rem;
    }
    .note-value {
      font-size: 0.85rem;
      color: var(--color-accent);
      font-style: italic;
    }
    .note-type {
      display: inline-block;
      padding: 0.1rem 0.4rem;
      border-radius: 3px;
      font-size: 0.7rem;
      font-weight: 500;
      margin-right: 0.5rem;
    }
    .note-type-feature { background: #dbeafe; color: #1e40af; }
    .note-type-bug { background: #fee2e2; color: #991b1b; }
    .note-type-improvement { background: #d1fae5; color: #065f46; }
    .company-section { margin-bottom: 2rem; }
    .hidden { display: none; }
    .generated-note { font-size: 0.7rem; color: var(--color-text-muted); text-align: center; margin-top: 3rem; }
  </style>
</head>
<body>
  <div class="header">
    <h1>What's New</h1>
    <p>Release notes for marketing and customer-facing teams</p>
  </div>
  <div class="container">
    <div class="view-tabs">
      <button class="view-tab active" onclick="switchView('all')">All</button>
      <button class="view-tab" onclick="switchView('Explore Learning')">Explore Learning</button>
      <button class="view-tab" onclick="switchView('Learning A-Z')">Learning A-Z</button>
    </div>

    ${months.map(month => renderMonth(month)).join('')}

    <p class="generated-note">Release notes generated from Jira data. Last updated: ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.</p>
  </div>

  <script>
    function switchView(company) {
      document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');

      document.querySelectorAll('.company-section').forEach(section => {
        if (company === 'all') {
          section.classList.remove('hidden');
        } else {
          section.classList.toggle('hidden', section.dataset.company !== company);
        }
      });
    }
  </script>
</body>
</html>`;
}

function renderMonth(month) {
  const companies = Object.entries(month.companies);
  return `
    <section class="month-section">
      <h2 class="month-title">${month.label}</h2>
      ${companies.map(([company, data]) => {
        const labelClass = company.includes('Explore') ? 'company-label-el' : 'company-label-laz';
        return `
          <div class="company-section" data-company="${company}">
            <span class="company-label ${labelClass}">${company}</span>
            ${data.notes.map(note => `
              <div class="note-card">
                <div class="note-headline">
                  ${note.type ? `<span class="note-type note-type-${note.type}">${note.type}</span>` : ''}
                  ${note.headline}
                </div>
                ${note.description ? `<p class="note-description">${note.description}</p>` : ''}
                ${note.valueAdd ? `<p class="note-value">${note.valueAdd}</p>` : ''}
              </div>
            `).join('')}
          </div>
        `;
      }).join('')}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log(' Release Notes Generator (AI-Powered)');
  console.log('═══════════════════════════════════════════\n');

  if (!GEMINI_API_KEY) {
    console.log('⚠ No GEMINI_API_KEY set. Will use raw ticket summaries as fallback.\n');
  }

  const data = loadReleases();
  const grouped = groupByMonth(data.releases);
  const cache = loadCache();

  // Determine which months to process
  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastKey = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;

  let monthsToProcess;
  if (specificMonth) {
    monthsToProcess = [specificMonth];
  } else if (generateAll) {
    monthsToProcess = Object.keys(grouped).sort().reverse();
  } else {
    monthsToProcess = Object.keys(grouped).filter(k => k >= lastKey).sort().reverse();
  }

  console.log(`Processing months: ${monthsToProcess.join(', ')}\n`);

  const monthlyNotes = {};

  for (const monthKey of monthsToProcess) {
    const month = grouped[monthKey];
    if (!month) {
      console.log(`  Skipping ${monthKey} — no data`);
      continue;
    }

    console.log(`▶ ${month.label}`);
    monthlyNotes[monthKey] = { key: monthKey, label: month.label, companies: {} };

    for (const [company, data] of Object.entries(month.companies)) {
      console.log(`  ${company}:`);
      const notes = [];

      // Process epics
      const epics = Object.values(data.epics);
      for (const epic of epics) {
        const cacheKey = `${monthKey}_${epic.key}`;

        if (cache[cacheKey]) {
          console.log(`    ✓ ${epic.summary} (cached)`);
          notes.push(cache[cacheKey]);
        } else {
          console.log(`    ⟳ ${epic.summary} (generating...)`);
          const note = await generateValueAdd(epic.summary, epic.issues, company);
          note.type = 'feature';
          notes.push(note);
          cache[cacheKey] = note;
        }
      }

      // Process standalone items
      if (data.standalone.length > 0) {
        const cacheKey = `${monthKey}_${company}_standalone`;
        if (cache[cacheKey]) {
          console.log(`    ✓ ${data.standalone.length} standalone items (cached)`);
          notes.push(...cache[cacheKey]);
        } else {
          console.log(`    ⟳ ${data.standalone.length} standalone items (generating...)`);
          const standaloneNotes = await generateStandaloneNotes(data.standalone, company);
          notes.push(...standaloneNotes);
          cache[cacheKey] = standaloneNotes;
        }
      }

      monthlyNotes[monthKey].companies[company] = { notes };
    }
  }

  // Save cache
  saveCache(cache);

  // Generate HTML
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const html = generateHTML(monthlyNotes);
  const outputPath = path.join(OUTPUT_DIR, 'index.html');
  fs.writeFileSync(outputPath, html);

  console.log(`\n✓ Release notes written to: ${outputPath}`);
  console.log(`  View at: /release-notes/ on the deployed site`);
}

main().catch(err => {
  console.error('✗ Generation failed:', err.message);
  process.exit(1);
});
