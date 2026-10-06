const ENDPOINT = 'https://api.linear.app/graphql';

export function buildIssuesBody(issueLimit, teamKey, assignedToMe, includeTriage) {
  const types = includeTriage ? '["triage", "unstarted", "started"]' : '["unstarted", "started"]';
  const parts = [`state: { type: { in: ${types} } }`];
  if (teamKey) parts.push(`team: { key: { eq: ${JSON.stringify(teamKey)} } }`);
  if (assignedToMe) parts.push('assignee: { isMe: { eq: true } }');
  const filter = `{ ${parts.join(', ')} }`;
  const query = `query($first: Int!) { issues(first: $first, orderBy: updatedAt, filter: ${filter}) { nodes { identifier title branchName url state { name } assignee { displayName } team { key } } } }`;
  return { query, variables: { first: issueLimit } };
}

// Split a Linear identifier ("BIT-123") into its team key and issue number.
export function parseIdentifier(identifier) {
  const s = String(identifier ?? '').trim();
  const i = s.lastIndexOf('-');
  if (i <= 0) return null;
  const number = s.slice(i + 1);
  if (!/^\d+$/.test(number)) return null;
  return { teamKey: s.slice(0, i), number: Number(number) };
}

// The details pane wants more than the picker: labels, priority, project/cycle, estimate
// and the comment threads. `comments` has no usable ordering argument (orderBy: createdAt
// still comes back thread-grouped), so threadComments sorts them here; 100 is a cap, not
// a page size we follow.
export function buildIssueBody(teamKey, number) {
  const filter = `{ team: { key: { eq: ${JSON.stringify(teamKey)} } }, number: { eq: ${number} } }`;
  const fields = 'identifier title description url priorityLabel estimate state { name } assignee { displayName } team { key } labels { nodes { name } } project { name } cycle { number name } comments(first: 100) { nodes { id createdAt body user { displayName } externalUser { name } parent { id } } }';
  const query = `query { issues(first: 1, filter: ${filter}) { nodes { ${fields} } } }`;
  return { query };
}

const DETAIL_FIELDS = 'identifier title description url priorityLabel estimate state { type name } assignee { displayName } team { key } labels { nodes { name } } project { name } cycle { number name } comments(first: 100) { nodes { id createdAt body user { displayName } externalUser { name } parent { id } } }';

// Linear keeps an issue's old identifiers after a team key change, but only `issue(id:)`
// resolves them: the team key filter matches the current key alone. A missing issue
// fails the whole response there, so this lookup asks for one issue at a time.
export function buildIssueByIdBody(identifier) {
  return { query: `query($id: String!) { issue(id: $id) { ${DETAIL_FIELDS} } }`, variables: { id: identifier } };
}

const notFoundOnly = (errors) => Array.isArray(errors) && errors.length > 0
  && errors.every((e) => /^Entity not found\b/.test(String(e?.message ?? '')));

// Only an identifier the team key filter missed comes here. Linear's "not found" is a
// miss (null), any other error still throws.
async function fetchByOldIdentifier(config, identifier, fetchFn) {
  const { json } = await postGraphQL(config, buildIssueByIdBody(identifier), fetchFn, { allowNotFound: true });
  return json?.data?.issue ?? null;
}

export function buildIssueBatchBody(identifiers) {
  const selections = identifiers.map((identifier, index) => {
    const parsed = parseIdentifier(identifier);
    if (!parsed || !/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/.test(identifier)) {
      throw new Error('worktree-from-linear: invalid issue list identifier');
    }
    const number = identifier.slice(identifier.lastIndexOf('-') + 1);
    return `i${index}: issues(first: 1, filter: { team: { key: { eq: ${JSON.stringify(parsed.teamKey)} } }, number: { eq: ${number} } }) { nodes { ${DETAIL_FIELDS} } }`;
  });
  return { query: `query { ${selections.join(' ')} }` };
}

// Comment nodes → thread roots, each with its `replies`, everything oldest-first.
// Linear threads are one level deep, so a reply hangs off its root ancestor; a reply
// whose parent fell outside the page becomes a root of its own rather than vanishing.
export function threadComments(nodes) {
  const list = (Array.isArray(nodes) ? nodes : []).map((n) => ({
    id: n.id ?? '',
    parentId: n.parent?.id ?? '',
    createdAt: n.createdAt ?? '',
    author: n.user?.displayName || n.externalUser?.name || 'unknown',
    body: n.body ?? '',
    replies: [],
  }));
  const byId = new Map(list.map((c) => [c.id, c]));
  const rootOf = (c, hops = 0) => {
    const parent = byId.get(c.parentId);
    return parent && parent !== c && hops < 10 ? rootOf(parent, hops + 1) : c;
  };
  const roots = [];
  for (const c of list) {
    const root = rootOf(c);
    if (root === c) roots.push(c);
    else root.replies.push(c);
  }
  const byTime = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
  for (const r of roots) r.replies.sort(byTime);
  return roots.sort(byTime);
}

export function parseIssues(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const nodes = data && data.data && data.data.issues && data.data.issues.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map((n) => ({
    identifier: n.identifier ?? '',
    title: n.title ?? '',
    branchName: n.branchName ?? '',
    url: n.url ?? '',
    stateName: n.state?.name ?? '',
    assignee: n.assignee?.displayName ?? '',
    teamKey: n.team?.key ?? '',
  }));
}

// POST a GraphQL body to Linear; return { json, text } or throw with a clear message.
async function postGraphQL(config, body, fetchFn, { allowNotFound = false } = {}) {
  const res = await fetchFn(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: config.linearApiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`worktree-from-linear: Linear API error ${res.status}: ${String(text).slice(0, 300)}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('worktree-from-linear: Linear returned non-JSON');
  }
  if (allowNotFound && json.errors && notFoundOnly(json.errors)) return { json: null, text };
  if (json.errors) {
    throw new Error(`worktree-from-linear: Linear GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  return { json, text };
}

export async function listIssues(config, fetchFn = fetch) {
  const { text } = await postGraphQL(config, buildIssuesBody(config.issueLimit, config.teamKey, config.assignedToMe, config.includeTriage), fetchFn);
  return parseIssues(text);
}

export async function fetchIssue(config, identifier, fetchFn = fetch) {
  const parsed = parseIdentifier(identifier);
  if (!parsed) throw new Error(`worktree-from-linear: bad issue identifier ${JSON.stringify(identifier)}`);
  const { json } = await postGraphQL(config, buildIssueBody(parsed.teamKey, parsed.number), fetchFn);
  const node = json?.data?.issues?.nodes?.[0] ?? await fetchByOldIdentifier(config, identifier, fetchFn);
  if (!node) throw new Error(`worktree-from-linear: issue ${identifier} not found`);
  return {
    identifier: node.identifier ?? identifier,
    title: node.title ?? '',
    description: node.description ?? '',
    url: node.url ?? '',
    stateName: node.state?.name ?? '',
    assignee: node.assignee?.displayName ?? '',
    // priorityLabel is "No priority" when unset; a cycle usually has only a number.
    priority: node.priorityLabel ?? '',
    estimate: typeof node.estimate === 'number' ? node.estimate : null,
    project: node.project?.name ?? '',
    cycle: node.cycle ? node.cycle.name || String(node.cycle.number ?? '') : '',
    labels: (node.labels?.nodes ?? []).map((l) => l.name).filter(Boolean),
    comments: threadComments(node.comments?.nodes),
  };
}

export async function fetchIssueBatch(config, identifiers, fetchFn = fetch) {
  if (!identifiers.length) return new Map();
  const { json } = await postGraphQL(config, buildIssueBatchBody(identifiers), fetchFn);
  const nodes = identifiers.map((identifier, index) => {
    const node = json?.data?.[`i${index}`]?.nodes?.[0];
    return node && node.identifier === identifier ? node : null;
  });
  // A stored id from before a team key change (HSYS-1 after HSYS became ENG) misses the
  // filter above. Look each miss up by its old id, and keep the result under that id.
  await Promise.all(nodes.map(async (node, index) => {
    if (!node) nodes[index] = await fetchByOldIdentifier(config, identifiers[index], fetchFn);
  }));
  const result = new Map();
  for (const [index, identifier] of identifiers.entries()) {
    const node = nodes[index];
    if (!node) continue;
    result.set(identifier, {
      identifier: node.identifier ?? identifier, title: node.title ?? '', description: node.description ?? '', url: node.url ?? '',
      stateName: node.state?.name ?? '', stateType: node.state?.type ?? '',
      assignee: node.assignee?.displayName ?? '', priority: node.priorityLabel ?? '',
      estimate: typeof node.estimate === 'number' ? node.estimate : null,
      project: node.project?.name ?? '', cycle: node.cycle ? node.cycle.name || String(node.cycle.number ?? '') : '',
      labels: (node.labels?.nodes ?? []).map((label) => label.name).filter(Boolean),
      comments: threadComments(node.comments?.nodes),
    });
  }
  return result;
}
