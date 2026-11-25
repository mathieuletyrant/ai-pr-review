const API = 'https://api.github.com';
const PAGE_SIZE = 100;
const NEXT_PAGE = /<([^>]+)>;\s*rel="next"/;

const RETRY_DELAYS_MS = [2_000, 8_000];
const REPEATABLE = new Set(['GET', 'PUT', 'PATCH', 'DELETE']);

/**
 * A REST and GraphQL client scoped to one repository. The token is optional where a proxy authenticates the calls.
 * A read or an edit GitHub answers with a 5xx, or that never reaches it, is sent again after each of `retryDelaysMs`;
 * a POST is sent once, since GitHub may have created what it answered 5xx for.
 */
export function createGitHub({ repo, token, fetch = globalThis.fetch, retryDelaysMs = RETRY_DELAYS_MS }) {
  async function sendOnce(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    if (!response.ok) {
      const message = `GitHub ${method} ${url} answered ${response.status}: ${(await response.text()).slice(0, 500)}`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return response;
  }

  async function send(method, url, body) {
    const delays = REPEATABLE.has(method) ? retryDelaysMs : [];
    for (let attempt = 0; ; attempt++) {
      try {
        return await sendOnce(method, url, body);
      } catch (error) {
        const transient = error.status === undefined || error.status >= 500;
        if (!transient || attempt >= delays.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  async function call(method, url, body) {
    const response = await send(method, url, body);
    return response.status === 204 ? null : response.json();
  }

  return {
    request: (method, path, body) => call(method, `${API}/repos/${repo}${path}`, body),
    async paginate(path) {
      const items = [];
      for (let page = 1; ; page++) {
        const batch = await call('GET', `${API}/repos/${repo}${path}?per_page=${PAGE_SIZE}&page=${page}`);
        items.push(...batch);
        if (batch.length < PAGE_SIZE) return items;
      }
    },
    /**
     * The pages of a list GitHub pages by cursor, from the first to the one `isLast` accepts or the one with no
     * `rel="next"` link. `path` already holds a query. Only the link's `after` cursor is read: GitHub writes the
     * link on `/repositories/<id>`, a path the cloud proxy refuses.
     */
    async follow(path, isLast = () => false) {
      const items = [];
      const first = `${API}/repos/${repo}${path}`;
      let url = first;
      while (url) {
        const response = await send('GET', url);
        const page = await response.json();
        items.push(...page);
        const next = isLast(page) ? null : NEXT_PAGE.exec(response.headers?.get('link') ?? '')?.[1];
        const cursor = next && new URL(next).searchParams.get('after');
        url = cursor ? `${first}&after=${encodeURIComponent(cursor)}` : null;
      }
      return items;
    },
    async graphql(query, variables) {
      const { data, errors } = await call('POST', `${API}/graphql`, { query, variables });
      if (errors) throw new Error(`GitHub GraphQL answered: ${JSON.stringify(errors)}`);
      return data;
    },
  };
}
