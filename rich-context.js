// rich-context.js  v0.9.5: returns null/empty; new renderPage builds buffer-style UI directly.
// Kept as a stub for backwards-compat with existing imports.
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export function buildRichContext() { return ''; }

export async function readProjectState(project, projectsDir) {
  if (!project) return null;
  const projDir = path.join(projectsDir, project.name);
  const liveDir = path.join(projDir, 'live');
  const draftsDir = path.join(projDir, 'drafts');
  const result = {
    name: project.name,
    description: project.description,
    github_repo: project.github_repo,
    live_files: [],
    live_total_size: 0,
    commits: [],
    active_aaps: (project.aaps || []).filter(a => !a.revoked).length,
    created_at: project.created_at,
  };
  try {
    const files = await fs.readdir(liveDir);
    for (const f of files) {
      if (f.startsWith('.')) continue;
      const stat = await fs.stat(path.join(liveDir, f));
      if (stat.isFile()) {
        result.live_files.push({ name: f, size: stat.size });
        result.live_total_size += stat.size;
      }
    }
  } catch (e) {}
  try {
    const log = execSync('git -C ' + JSON.stringify(draftsDir) + ' log --pretty=format:"%h|%s|%ai" -n 5 2>/dev/null', { encoding: 'utf8' });
    result.commits = log.split('\n').filter(Boolean).map(line => {
      const [hash, msg, date] = line.split('|');
      return { hash, msg, date };
    });
  } catch (e) {}
  return result;
}
