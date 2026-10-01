const stamp = (iso) => String(iso ?? '').slice(0, 16).replace('T', ' ');
const quote = (text) => text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
const countComments = (roots) => roots.reduce((n, c) => n + 1 + (c.replies?.length ?? 0), 0);

// Linear writes a pasted URL as a link whose text is the URL itself, and glow prints both
// the text and the target — so the address appears twice. Collapse those back to a bare
// URL; links with real link text are left alone.
const unwrapSelfLinks = (text) => text.replace(/\[(https?:\/\/[^\]\s]+)\]\(<?\1>?\)/g, '$1');

// The same issue as markdown, for panes where glow is available: header, meta, the
// description, then every comment oldest-first with its replies quoted underneath.
// Errors fall back to the plain panel — markdown would only dress up a failure.
export function formatIssueMarkdown(issue) {
  if (!issue || issue.error) return formatIssue(issue);
  const meta = [
    issue.stateName,
    issue.assignee,
    issue.priority && issue.priority !== 'No priority' && `Priority: ${issue.priority}`,
    typeof issue.estimate === 'number' && `Estimate: ${issue.estimate}`,
  ].filter(Boolean).join('  ·  ');
  const facts = [
    issue.project && `**Project** ${issue.project}`,
    issue.cycle && `**Cycle** ${issue.cycle}`,
    issue.labels?.length && `**Labels** ${issue.labels.map((l) => `\`${l}\``).join(', ')}`,
  ].filter(Boolean).join('  ·  ');
  const lines = [`# ${[issue.identifier, issue.title].filter(Boolean).join(' · ')}`, ''];
  if (meta) lines.push(meta, '');
  if (facts) lines.push(facts, '');
  if (issue.url) lines.push(issue.url, '');
  const body = unwrapSelfLinks(issue.description?.trim() || '');
  lines.push('---', '', body || '*(no description)*', '');
  const comments = issue.comments ?? [];
  if (comments.length) {
    lines.push('---', '', `## Comments (${countComments(comments)})`, '');
    for (const c of comments) {
      lines.push(`### ${c.author} · ${stamp(c.createdAt)}`, '', unwrapSelfLinks(c.body.trim()), '');
      for (const r of c.replies ?? []) lines.push(quote(`**${r.author}** · ${stamp(r.createdAt)}\n\n${unwrapSelfLinks(r.body.trim())}`), '');
    }
  }
  return lines.join('\n');
}

// Render a Linear issue (or an { identifier, error } placeholder) as a plain-text
// panel for the details pane. Also the fallback when glow is not installed.
export function formatIssue(issue) {
  if (!issue || issue.error) {
    return `Could not load ${issue?.identifier || 'issue'}: ${issue?.error || 'unknown error'}\n`;
  }
  const meta = [
    issue.stateName && `state: ${issue.stateName}`,
    issue.assignee && `assignee: ${issue.assignee}`,
  ].filter(Boolean).join('    ');
  const body = issue.description && issue.description.trim() ? issue.description.trim() : '(no description)';
  const lines = [[issue.identifier, issue.title].filter(Boolean).join('  ')];
  if (meta) lines.push(meta);
  if (issue.url) lines.push(issue.url);
  lines.push('', body, '');
  return lines.join('\n');
}

export function formatIssueList(view, width = 80) {
  if (!view.ids.length && !view.override) return '';
  const columns = Math.max(1, width - 2);
  const rows = [...(view.ids.length ? view.ids : [view.override])];
  if (view.override && !rows.includes(view.override)) rows.unshift(view.override);
  const lines = rows.map((id) => {
    const issue = view.issues.get(id);
    const prefix = `${id === view.selected ? '▸' : ' '} ${id}  ${issue?.stateName || 'Loading'}  `;
    const room = Math.max(0, columns - Array.from(prefix).length);
    const title = Array.from(String(issue?.title || '')).slice(0, room).join('');
    return Array.from(`${prefix}${title}`).slice(0, columns).join('');
  });
  lines.push('─'.repeat(columns));
  const selected = view.issues.get(view.selected);
  lines.push(selected ? formatIssue(selected).trimEnd() : `${view.selected || 'Issue'} is loading.`);
  if (view.error) lines.push('', view.error);
  lines.push('', 'j/k select · Enter full view · o open in Linear · q shell');
  return `${lines.join('\n')}\n`;
}
