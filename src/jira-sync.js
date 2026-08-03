#!/usr/bin/env node

/**
 * Jira Sync Script
 *
 * Pulls Fix Versions and associated issues from both Jira instances,
 * merges them with existing asset links (Google Docs/Slides), and
 * writes the unified release data to data/releases.json.
 *
 * Usage:
 *   node src/jira-sync.js              # Full sync
 *   node src/jira-sync.js --dry-run    # Preview without writing
 */

const fs = require('fs');
const path = require('path');

// Load .env file
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'jira.config.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'releases.json');
const ASSETS_PATH = path.join(__dirname, '..', 'data', 'release-assets.json');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw);

  // Resolve shared auth from environment variables
  const sharedAuth = {
    email: resolveEnvVar(config.auth.email),
    apiToken: resolveEnvVar(config.auth.apiToken)
  };

  // Apply shared auth to each instance
  for (const instance of config.instances) {
    instance.auth = sharedAuth;
  }

  return config;
}

function resolveEnvVar(value) {
  const match = value.match(/^\$\{(.+)\}$/);
  if (match) {
    const envValue = process.env[match[1]];
    if (!envValue) {
      throw new Error(`Environment variable ${match[1]} is not set. See .env.example`);
    }
    return envValue;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Jira API Client
// ---------------------------------------------------------------------------

class JiraClient {
  constructor(instance, syncConfig) {
    this.baseUrl = instance.baseUrl.replace(/\/$/, '');
    this.auth = Buffer.from(`${instance.auth.email}:${instance.auth.apiToken}`).toString('base64');
    this.instanceId = instance.id;
    this.instanceName = instance.name;
    this.projects = instance.projects;
    this.releaseFilter = instance.releaseFilter;
    this.publishedMonthsBack = (syncConfig && syncConfig.publishedMonthsBack) || 6;
  }

  async fetch(endpoint) {
    const url = `${this.baseUrl}/rest/api/3${endpoint}`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Basic ${this.auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jira API error (${response.status}) for ${url}: ${text}`);
    }

    return response.json();
  }

  async fetchPost(endpoint, body) {
    const url = `${this.baseUrl}/rest/api/3${endpoint}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${this.auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jira API error (${response.status}) for ${url}: ${text}`);
    }

    return response.json();
  }

  /**
   * Get all projects accessible to this user
   */
  async getAllProjects() {
    const data = await this.fetch('/project?expand=description&maxResults=200');
    return (data || []).map(p => p.key);
  }

  /**
   * Get all Fix Versions for a project
   */
  async getVersions(projectKey) {
    const data = await this.fetch(`/project/${projectKey}/version?orderBy=-releaseDate&maxResults=50`);
    return data.values || data;
  }

  /**
   * Get issues for a specific Fix Version
   */
  async getIssuesForVersion(projectKey, versionId, versionName) {
    const jql = `project = "${projectKey}" AND fixVersion = ${versionId}${
      this.releaseFilter.additionalJql ? ` AND ${this.releaseFilter.additionalJql}` : ''
    }`;
    const fields = 'summary,issuetype,priority,status,parent';

    try {
      if (process.argv.includes('--debug')) {
        console.log(`      JQL: ${jql}`);
      }

      const response = await this.fetchPost('/search/jql', {
        jql,
        fields: fields.split(','),
        maxResults: 100
      });

      if (process.argv.includes('--debug')) {
        console.log(`      Response keys: ${Object.keys(response).join(', ')}`);
        console.log(`      Total: ${response.total}, Issues array length: ${(response.issues || []).length}`);
      }

      return (response.issues || []).map(issue => this.normalizeIssue(issue, projectKey));
    } catch (err) {
      console.error(`      ⚠ Issue query failed for "${versionName}": ${err.message}`);
      return [];
    }
  }

  /**
   * Normalize a Jira issue to our schema
   */
  normalizeIssue(issue, projectKey) {
    const typeMap = {
      'story': 'feature',
      'new feature': 'feature',
      'feature': 'feature',
      'bug': 'bug',
      'improvement': 'improvement',
      'task': 'task',
      'sub-task': 'task',
      'subtask': 'task'
    };

    const priorityMap = {
      'highest': 'critical',
      'critical': 'critical',
      'high': 'high',
      'medium': 'medium',
      'low': 'low',
      'lowest': 'low'
    };

    const rawType = (issue.fields.issuetype?.name || '').toLowerCase();
    const rawPriority = (issue.fields.priority?.name || '').toLowerCase();

    // Extract epic/parent info
    const parent = issue.fields.parent;
    let epic = null;
    if (parent) {
      epic = {
        key: parent.key,
        summary: parent.fields?.summary || parent.key,
        url: `${this.baseUrl}/browse/${parent.key}`
      };
    }

    return {
      key: issue.key,
      summary: issue.fields.summary,
      type: typeMap[rawType] || 'other',
      priority: priorityMap[rawPriority] || 'medium',
      status: issue.fields.status?.name || 'Unknown',
      url: `${this.baseUrl}/browse/${issue.key}`,
      epic
    };
  }

  /**
   * Build a release object from a Jira Fix Version
   */
  buildRelease(version, projectKey, issues) {
    const isReleased = version.released === true;

    return {
      id: `${this.instanceId}_${version.id}`,
      name: version.name,
      description: version.description || '',
      company: this.instanceId,
      companyName: this.instanceName,
      project: projectKey,
      status: isReleased ? 'published' : 'upcoming',
      releaseDate: version.releaseDate || null,
      releasedAt: isReleased && version.releaseDate
        ? new Date(version.releaseDate + 'T00:00:00Z').toISOString()
        : null,
      source: {
        instanceId: this.instanceId,
        versionId: String(version.id),
        versionUrl: `${this.baseUrl}/projects/${projectKey}/versions/${version.id}`,
        projectKey
      },
      assets: {
        preReleaseNotes: null,
        presentation: null,
        additionalLinks: []
      },
      issues,
      highlights: [],
      tags: []
    };
  }

  /**
   * Sync all projects for this instance
   */
  async syncAll() {
    const releases = [];

    // Resolve project list — fetch all if set to "all"
    let projectKeys = this.projects;
    if (projectKeys === 'all') {
      console.log(`  Discovering all projects...`);
      projectKeys = await this.getAllProjects();
      console.log(`  Found ${projectKeys.length} projects: ${projectKeys.join(', ')}`);
    }

    for (const projectKey of projectKeys) {
      console.log(`  Syncing ${this.instanceName} / ${projectKey}...`);

      try {
        const versions = await this.getVersions(projectKey);
        console.log(`    Found ${versions.length} versions`);

        for (const version of versions) {
          // Skip archived versions
          if (version.archived) continue;

          // Skip old published versions (only keep last 6 months)
          if (version.released && version.releaseDate) {
            const cutoff = new Date('2025-01-01');
            const releaseDate = new Date(version.releaseDate);
            if (releaseDate < cutoff) continue;
          }

          // Skip released versions with no date (can't determine age)
          if (version.released && !version.releaseDate) continue;

          const issues = await this.getIssuesForVersion(projectKey, version.id, version.name);

          // Skip releases with no issues
          if (issues.length === 0) continue;

          const release = this.buildRelease(version, projectKey, issues);
          releases.push(release);
          console.log(`    ✓ ${version.name} (${release.status}) - ${issues.length} issues`);
        }
      } catch (err) {
        console.error(`    ✗ Error syncing ${projectKey}: ${err.message}`);
      }
    }

    return releases;
  }
}

// ---------------------------------------------------------------------------
// Asset Merging
// ---------------------------------------------------------------------------

/**
 * Loads manually-maintained asset links and merges them into synced releases.
 * This preserves Google Docs/Slides links that are added manually or via
 * a separate process.
 */
function mergeAssets(releases) {
  if (!fs.existsSync(ASSETS_PATH)) {
    return releases;
  }

  const assetsRaw = fs.readFileSync(ASSETS_PATH, 'utf-8');
  const assetsMap = JSON.parse(assetsRaw); // { "release-id": { assets, highlights, tags } }

  return releases.map(release => {
    const overrides = assetsMap[release.id];
    if (!overrides) return release;

    return {
      ...release,
      assets: {
        preReleaseNotes: overrides.preReleaseNotes || release.assets.preReleaseNotes,
        presentation: overrides.presentation || release.assets.presentation,
        additionalLinks: [
          ...(release.assets.additionalLinks || []),
          ...(overrides.additionalLinks || [])
        ]
      },
      highlights: overrides.highlights || release.highlights,
      tags: overrides.tags || release.tags
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('═══════════════════════════════════════════');
  console.log(' Jira Release Sync');
  console.log(`═══════════════════════════════════════════`);
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no file write)' : 'LIVE'}`);
  console.log('');

  const config = loadConfig();
  let allReleases = [];

  for (const instance of config.instances) {
    console.log(`\n▶ ${instance.name} (${instance.baseUrl})`);
    const client = new JiraClient(instance);
    const releases = await client.syncAll();
    allReleases = allReleases.concat(releases);
  }

  // Merge in manually-maintained asset links
  allReleases = mergeAssets(allReleases);

  // Sort: upcoming by releaseDate asc, published by releasedAt desc
  allReleases.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === 'upcoming' ? -1 : 1;
    }
    const dateA = a.releaseDate || '9999-12-31';
    const dateB = b.releaseDate || '9999-12-31';
    if (a.status === 'upcoming') {
      return dateA.localeCompare(dateB);
    }
    return dateB.localeCompare(dateA);
  });

  const output = {
    lastSyncedAt: new Date().toISOString(),
    releases: allReleases
  };

  console.log('\n───────────────────────────────────────────');
  console.log(`Total releases: ${allReleases.length}`);
  console.log(`  Upcoming: ${allReleases.filter(r => r.status === 'upcoming').length}`);
  console.log(`  Published: ${allReleases.filter(r => r.status === 'published').length}`);
  console.log('───────────────────────────────────────────');

  if (isDryRun) {
    console.log('\n[DRY RUN] Would write to:', OUTPUT_PATH);
    console.log(JSON.stringify(output, null, 2));
  } else {
    // Ensure data directory exists
    const dataDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log(`\n✓ Written to ${OUTPUT_PATH}`);
  }
}

main().catch(err => {
  console.error('\n✗ Sync failed:', err.message);
  process.exit(1);
});
