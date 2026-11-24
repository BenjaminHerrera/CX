// GitHub polling and change detection. All requests are GETs to the API origin.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

class WatchError extends Error {
    constructor(message, {retry = false, delay = 0} = {}) {
        super(message);
        this.retry = retry;
        this.delay = delay;
    }
}

function credential(options) {
    function read(file) {
        try { return fs.readFileSync(file, 'utf8').trim(); }
        catch { throw new WatchError('Cannot read the GitHub token file.'); }
    }
    const valid = (token, source) => {
        if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new WatchError('The GitHub credential must contain one token.');
        return {token, source};
    };
    if (options['token-file']) return valid(read(options['token-file']), '--token-file');
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
        if (process.env[name]) return valid(process.env[name].trim(), name);
    }
    let files;
    const directory = '/workspace/cx-external';
    try {
        files = fs.readdirSync(directory, {withFileTypes: true})
            .filter(item => item.isFile() && /token/i.test(item.name));
    } catch (error) {
        if (error.code !== 'ENOENT') throw new WatchError('Cannot inspect /workspace/cx-external for a token.');
        files = [];
    }
    if (files.length > 1) throw new WatchError('Multiple token files found. Select one with --token-file.');
    if (files.length) return valid(read(path.join(directory, files[0].name)), 'cx-external token file');
    if (fs.existsSync('/cx-github-token')) return valid(read('/cx-github-token'), 'CX_GH_TOKEN_FILE');
    const result = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 8192,
        env: {...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: ''},
    });
    if (result.status === 0) return valid(result.stdout.trim(), 'gh auth token');
    throw new WatchError('GitHub credentials unavailable. Use --token-file or GH_TOKEN.');
}

class GitHubAPI {
    constructor(token, base, verbose, signal) {
        this.token = token;
        this.base = new URL(base);
        this.verbose = verbose;
        this.signal = signal;
        this.cache = new Map();
        this.waitUntil = 0;
    }

    async get(resource, {optional = false, repository = false} = {}) {
        if (Date.now() < this.waitUntil) {
            throw new WatchError('GitHub rate limit. Retrying after the reset.', {
                retry: true, delay: this.waitUntil - Date.now(),
            });
        }
        const url = new URL(resource, this.base);
        if (url.origin !== this.base.origin || url.username || url.password) {
            throw new WatchError('GitHub pagination returned an unexpected origin.');
        }
        const key = url.href;
        const cached = this.cache.get(key);
        const headers = {Authorization: 'Bearer ' + this.token, Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cx-watch'};
        if (cached?.etag) headers['If-None-Match'] = cached.etag;
        let response;
        try {
            response = await fetch(url, {
                method: 'GET', headers, redirect: 'manual',
                signal: AbortSignal.any([this.signal, AbortSignal.timeout(12000)]),
            });
        } catch {
            throw new WatchError('GitHub request timed out or lost its connection.', {retry: true});
        }
        this.verbose('GitHub HTTP ' + response.status);
        const retryAfter = response.headers.get('retry-after');
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (response.status === 429 || retryAfter || remaining === '0') {
            const delay = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now())
                : Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
            this.waitUntil = Date.now() + (delay > 0 ? delay : 60000);
            if (!response.ok && response.status !== 304) {
                await response.body?.cancel();
                throw new WatchError('GitHub rate limit. Retrying after the reset.', {
                    retry: true, delay: this.waitUntil - Date.now(),
                });
            }
        }
        if (response.status === 304 && cached) return cached;
        if (!response.ok) {
            await response.body?.cancel();
            if (optional && [403, 404].includes(response.status)) return {data: null};
            if (response.status === 401) throw new WatchError('GitHub rejected the credential (HTTP 401).');
            if (response.status === 404 && repository) {
                throw new WatchError('GitHub token cannot see this repository (HTTP 404). Check the repository and token access.');
            }
            throw new WatchError('GitHub request failed (HTTP ' + response.status + ').', {
                retry: response.status >= 500,
            });
        }
        let data;
        try { data = await response.json(); }
        catch { throw new WatchError('GitHub returned an unreadable response.', {retry: true}); }
        const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
        const entry = {data, next, etag: response.headers.get('etag')};
        if (entry.etag) {
            this.cache.set(key, entry);
            if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value);
        }
        return entry;
    }

    async list(resource, key, options) {
        const rows = [];
        let next = resource + (resource.includes('?') ? '&' : '?') + 'per_page=100';
        for (let page = 0; next; page++) {
            if (page >= 100) throw new WatchError('GitHub pagination exceeds 100 pages. Narrow the watch.');
            const item = await this.get(next, options);
            if (item.data === null) return rows;
            const batch = key ? item.data[key] : item.data;
            if (!Array.isArray(batch)) throw new WatchError('GitHub returned an unexpected list.', {retry: true});
            rows.push(...batch);
            next = item.next;
        }
        return rows;
    }
}

const short = sha => sha?.slice(0, 8);
const prsState = pr => pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'ready';

function matchesPR(pr, options) {
    return options.branch.includes(pr.head.ref) ||
        options.closes.some(number => new RegExp('\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#' + number + '\\b', 'i').test(pr.body || ''));
}

async function ciStatus(api, base, sha) {
    const runs = await api.list(base + '/actions/runs?head_sha=' + sha, 'workflow_runs');
    const jobs = [];
    for (const run of runs) {
        const childJobs = await api.list(base + '/actions/runs/' + run.id + '/jobs', 'jobs');
        jobs.push(...childJobs);
        if (!childJobs.length || (run.status !== 'completed' && childJobs.every(job => job.status === 'completed'))) {
            jobs.push(run);
        }
    }
    const checks = await api.list(base + '/commits/' + sha + '/check-runs', 'check_runs', {optional: true});
    const actionIds = new Set(jobs.map(job => job.check_run_url?.split('/').at(-1)).filter(Boolean));
    const independent = checks.filter(check => !actionIds.has(String(check.id)));
    jobs.push(...independent);
    const generation = JSON.stringify({
        runs: runs.map(run => [run.id, run.run_attempt || 1]).sort(),
        checks: independent.map(check => check.id).sort(),
    });
    if (!jobs.length) return null;
    if (jobs.some(job => job.status !== 'completed')) return {status: 'pending', generation};
    const passing = new Set(['success', 'neutral', 'skipped']);
    const failures = jobs.filter(job => !passing.has(job.conclusion) && job.conclusion !== 'cancelled');
    const cancelled = jobs.filter(job => job.conclusion === 'cancelled');
    return {
        generation,
        status: failures.length ? 'failure' : cancelled.length ? 'cancelled' : 'success',
        counts: (jobs.length - failures.length - cancelled.length) + '/' + jobs.length,
        failing: [...new Set([...failures, ...cancelled].map(job => job.name))],
    };
}

function activity(rows, old, target, kind, first, since, emit, redact) {
    const seen = new Set(old || []);
    let last = '';
    for (const row of rows) {
        const at = row.submitted_at || row.updated_at || row.created_at;
        if (!at) continue;
        if (at > last) last = at;
        const id = String(row.id) + '/' + at;
        if (seen.has(id)) continue;
        seen.add(id);
        if (first && (!since || Date.parse(at) <= since)) continue;
        emit(target, kind, {
            id: row.id, author: row.user?.login, at,
            body: redact(row.body || '').replace(/[\x00-\x20\x7f-\x9f\u2028\u2029]+/g, ' ').trim().slice(0, 80),
            ...(kind === 'review' ? {state: row.state, commit: short(row.commit_id)} : {}),
            ...(kind === 'review_comment' ? {path: row.path, reply: Boolean(row.in_reply_to_id)} : {}),
        });
    }
    return {seen: [...seen], last};
}

async function githubPoll(api, options, snapshot, report, redact) {
    const base = '/repos/' + options.repo;
    const first = !snapshot.initialized;
    await api.get(base, {repository: true});
    const prs = snapshot.prs ||= {};
    const issues = snapshot.issues ||= {};
    const numbers = new Set([...options.pr, ...Object.keys(prs).map(Number)]);
    if (options.branch.length || options.closes.length) {
        for (const pr of await api.list(base + '/pulls?state=open')) {
            if (matchesPR(pr, options)) numbers.add(pr.number);
        }
    }
    const overview = {};
    let end, ciDone;
    for (const number of [...numbers].sort((a, b) => a - b)) {
        const target = 'pr#' + number;
        const {data: pr} = await api.get(base + '/pulls/' + number);
        const old = prs[number];
        const state = prsState(pr);
        const sha = pr.head.sha;
        if (!old && (!first || options.since && Date.parse(pr.created_at) > options.since) && !options.pr.includes(number)) {
            report(target, 'pr_opened', {id: number, sha: short(sha), author: pr.user?.login, at: pr.created_at});
        }
        if (old && old.sha !== sha) {
            const commits = await api.list(base + '/compare/' + old.sha + '...' + sha, 'commits', {optional: true});
            report(target, 'head', {sha: short(sha), prev: short(old.sha), commits: commits.map(item => short(item.sha))});
        }
        if (old && old.state !== state) {
            report(target, 'state', {state, merge: state === 'merged' ? short(pr.merge_commit_sha) : undefined});
        }
        const comments = activity(await api.list(base + '/issues/' + number + '/comments'), old?.comments,
            target, 'comment', first, options.since, report, redact);
        const reviews = activity(await api.list(base + '/pulls/' + number + '/reviews'), old?.reviews,
            target, 'review', first, options.since, report, redact);
        const inline = activity(await api.list(base + '/pulls/' + number + '/comments'), old?.inline,
            target, 'review_comment', first, options.since, report, redact);
        const ci = await ciStatus(api, base, sha);
        const phases = old?.phases || {};
        const previousCI = phases[sha];
        if (ci && JSON.stringify(previousCI) !== JSON.stringify(ci)) {
            if (!first) {
                if (!previousCI || previousCI.generation !== ci.generation ||
                        ci.status === 'pending' && previousCI.status !== 'pending') {
                    report(target, 'ci', {sha: short(sha), generation: ci.generation, status: 'pending'});
                }
                if (ci.status !== 'pending') report(target, 'ci', {sha: short(sha), ...ci});
            }
            phases[sha] = ci;
        }
        if (ci && ci.status !== 'pending') ciDone ||= target;
        if (state === options.until || (options.until === 'any' && ['closed', 'merged'].includes(state))) end ||= {reason: state, target};
        prs[number] = {state, sha, phases, comments: comments.seen, reviews: reviews.seen, inline: inline.seen};
        overview[target] = {state, sha: short(sha), ci: ci?.status, last_comment: [comments.last, inline.last].sort().at(-1) || undefined};
    }
    for (const number of options.issue) {
        const target = 'issue#' + number;
        const {data: issue} = await api.get(base + '/issues/' + number);
        const old = issues[number];
        if (old && old.state !== issue.state) report(target, 'state', {state: issue.state});
        const comments = activity(await api.list(base + '/issues/' + number + '/comments'), old?.comments,
            target, 'comment', first, options.since, report, redact);
        issues[number] = {state: issue.state, comments: comments.seen};
        overview[target] = {state: issue.state, last_comment: comments.last || undefined};
    }
    return {summary: overview, end: end || (options['until-ci'] && ciDone ? {reason: 'ci', target: ciDone} : null)};
}

module.exports = {GitHubAPI, WatchError, credential, githubPoll};
