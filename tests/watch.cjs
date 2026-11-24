const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const {once} = require('node:events');
const {test} = require('node:test');
const {GitHubAPI} = require('../container/cx-watch-github.cjs');

const watch = path.resolve(__dirname, '../container/cx-watch');
const token = 'fixture_secret_do_not_output';
const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const actor = {login: 'test-user'};
const timestamp = '2026-01-01T00:00:00Z';

function temporary(t) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-watch-test-'));
    t.after(() => fs.rmSync(folder, {force: true, recursive: true}));
    return folder;
}

async function run(args, {base, env = {}} = {}) {
    const code = "require(process.argv[1]).main(process.argv.slice(3), {apiBase: process.argv[2]}).then(value => process.exitCode = value)";
    const child = spawn(process.execPath, base ? ['-e', code, watch, base, ...args] : [watch, ...args], {
        env: {...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', ...env}, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = async stream => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks).toString();
    };
    const [stdout, stderr, [status]] = await Promise.all([collect(child.stdout), collect(child.stderr), once(child, 'close')]);
    const events = stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
    return {events, status, stdout, stderr};
}

async function server(t, respond) {
    const httpServer = http.createServer(respond);
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    t.after(() => httpServer.close());
    return 'http://127.0.0.1:' + httpServer.address().port;
}

test('GitHub baseline, discovery, new head, activity, CI and merge survive restarts', async t => {
    const file = path.join(temporary(t), 'state.json');
    let phase = 0;
    const base = await server(t, (req, res) => {
        assert.equal(req.method, 'GET');
        assert.equal(req.headers.authorization, 'Bearer ' + token);
        const resource = new URL(req.url, 'http://localhost').pathname.replace('/repos/owner/repo', '');
        const head = {sha: phase >= 3 ? b : a, ref: 'branch'};
        const pr = {number: 5, head, user: actor, state: phase >= 5 ? 'closed' : 'open',
            merged: phase >= 5, merge_commit_sha: a, created_at: timestamp, body: 'Closes #18'};
        const row = {id: 1, user: actor, created_at: timestamp, updated_at: timestamp, body: 'new\ntext ' + token};
        let data;
        if (resource === '') data = {name: 'repo'};
        else if (resource === '/pulls') data = phase ? [pr] : [];
        else if (resource === '/pulls/5') data = pr;
        else if (resource === '/issues/18') data = {state: 'open'};
        else if (resource === '/issues/18/comments') data = phase >= 2 ? [row] : [];
        else if (resource === '/issues/5/comments') data = phase >= 3 ? [row] : [];
        else if (resource === '/pulls/5/reviews') data = phase >= 3 ? [{...row, submitted_at: timestamp, state: 'APPROVED', commit_id: b}] : [];
        else if (resource === '/pulls/5/comments') data = phase >= 3 ? [{...row, path: 'file', in_reply_to_id: 17}] : [];
        else if (resource.startsWith('/compare/')) data = {commits: [{sha: b}]};
        else if (resource === '/actions/runs') data = {workflow_runs: phase >= 3 ? [{id: 10, status: phase >= 4 ? 'completed' : 'in_progress'}] : []};
        else if (resource === '/actions/runs/10/jobs') data = {jobs: [{
            name: 'Checks', check_run_url: 'https://api.github.com/check-runs/8',
            status: phase >= 4 ? 'completed' : 'in_progress', conclusion: phase >= 4 ? 'success' : null,
        }]};
        else if (resource.endsWith('/check-runs')) {
            if (phase < 3) { res.writeHead(403).end(); return; }
            data = {check_runs: [{id: 8, status: phase >= 4 ? 'completed' : 'in_progress', conclusion: 'success'}]};
        } else {
            res.writeHead(404).end();
            return;
        }
        res.setHeader('ETag', '"' + phase + '"');
        res.end(JSON.stringify(data));
    });
    const args = ['github','--repo','owner/repo','--closes','18','--issue','18','--json','--once','--verbose','--state',file];
    async function watchPhase(expected) {
        const result = await run(args, {base, env: {GH_TOKEN: token}});
        assert.equal(result.status, 0, result.stdout);
        assert.deepEqual(result.events.map(item => item.event), expected);
        for (const text of [result.stdout, result.stderr, fs.readFileSync(file, 'utf8')]) assert.ok(!text.includes(token));
        return result.events;
    }
    await watchPhase(['baseline']);
    await watchPhase([]);
    phase = 1;
    await watchPhase(['pr_opened']);
    phase = 2;
    const [issue] = await watchPhase(['comment']);
    assert.equal(issue.target, 'issue#18');
    phase = 3;
    const [head, comment, review, inline, waiting] = await watchPhase(['head','comment','review','review_comment','ci']);
    assert.deepEqual(head.data.commits, ['bbbbbbbb']);
    assert.equal(comment.data.body, 'new text [redacted]');
    assert.equal(review.data.state, 'APPROVED');
    assert.equal(inline.data.reply, true);
    assert.equal(waiting.data.status, 'pending');
    phase = 4;
    const [complete] = await watchPhase(['ci']);
    assert.equal(complete.data.status, 'success');
    assert.equal(complete.data.counts, '1/1');
    await watchPhase([]);
    phase = 5;
    const [merged, end] = await watchPhase(['state','end']);
    assert.equal(merged.data.merge, 'aaaaaaaa');
    assert.equal(end.data.reason, 'merged');
});

test('GitHub HTTP 404 explains token visibility, HTTP 304 and rate limits are respected', async t => {
    let calls = 0;
    const base = await server(t, (req, res) => {
        calls++;
        if (req.url.startsWith('/repos/')) return res.writeHead(404).end();
        if (req.url === '/limit') return res.writeHead(429, {'Retry-After': '1'}).end();
        if (req.headers['if-none-match'] === '"abc"') return res.writeHead(304).end();
        res.writeHead(200, {ETag: '"abc"'}).end('{"ok":true}');
    });
    const result = await run(['github','--repo','owner/repo','--pr','3','--json','--once','--state',path.join(temporary(t), 'state')], {
        base, env: {GH_TOKEN: token},
    });
    assert.equal(result.status, 1);
    assert.match(result.events[0].data.message, /token cannot see this repository/i);
    const api = new GitHubAPI(token, base, () => {}, new AbortController().signal);
    assert.deepEqual((await api.get('/etag')).data, {ok: true});
    assert.deepEqual((await api.get('/etag')).data, {ok: true});
    await assert.rejects(api.get('/limit'), error => error.retry && error.delay > 0);
    const before = calls;
    await assert.rejects(api.get('/etag'), /rate limit/);
    assert.equal(calls, before);
});

test('local change detection, termination, and timeout clean up the command', async t => {
    const folder = temporary(t);
    const file = path.join(folder, 'state');
    const input = path.join(folder, 'input');
    fs.writeFileSync(input, 'initial');
    const args = ['local','--cmd','cat ' + input,'--state',file,'--json','--once'];
    assert.deepEqual((await run(args)).events.map(event => event.event), ['baseline']);
    assert.deepEqual((await run(args)).events, []);
    fs.writeFileSync(input, 'ready');
    const changed = await run([...args,'--until-match','ready']);
    assert.deepEqual(changed.events.map(item => item.event), ['changed','end']);
    const childPid = path.join(folder, 'pid');
    const hung = await run(['local','--cmd','echo $$ > ' + childPid + '; exec sleep 15',
        '--cmd-timeout','1','--once','--json','--state',path.join(folder,'timeout')]);
    assert.equal(hung.status, 0);
    assert.match(hung.events[0].data.message, /timed out/);
    assert.throws(() => process.kill(Number(fs.readFileSync(childPid, 'utf8')), 0), {code: 'ESRCH'});
    const bounded = await run(['local','--cmd','printf ready','--max-runtime','0.5','--json',
        '--state',path.join(folder,'bounded')]);
    assert.deepEqual(bounded.events.map(item => item.event), ['baseline','end']);
    assert.equal(bounded.events[1].data.reason, 'max-runtime');
});

test('file state tracks appearance, new matching lines and disappearance', async t => {
    const folder = temporary(t);
    const file = path.join(folder, 'output');
    const state = path.join(folder, 'state');
    const args = ['file','--path',file,'--grep','yes','--json','--once','--state',state];
    assert.deepEqual((await run(args)).events.map(event => event.event), ['baseline']);
    fs.writeFileSync(file, 'ignore\nyes 1\nyes 2\n');
    const {events} = await run(args);
    assert.deepEqual(events.map(item => item.event), ['appeared','line']);
    assert.equal(events[1].data.count, 2);
    assert.deepEqual((await run(args)).events, []);
    fs.appendFileSync(file, 'yes complete\n');
    assert.deepEqual((await run([...args, '--until-match', 'complete'])).events.map(item => item.event), ['changed','line','end']);
    fs.unlinkSync(file);
    assert.deepEqual((await run(args)).events.map(item => item.event), ['disappeared']);
});

test('remote watch asks the CX bridge for an independent batch command', async t => {
    const dir = temporary(t);
    const socketPath = path.join(dir, 'bridge.sock');
    const bridge = net.createServer(socket => {
        socket.on('data', data => {
            assert.deepEqual(JSON.parse(data), {op: 'watch', host: 'fixture', command: 'printf ready', timeout: 30000});
            socket.end(JSON.stringify({type: 'watch', status: 0, digest: 'example', out: 'cmVhZHk=', err: ''}));
        });
    });
    bridge.listen(socketPath);
    await once(bridge, 'listening');
    t.after(() => bridge.close());
    const result = await run(['remote','--host','fixture','--cmd','printf ready','--until-match','ready',
        '--state',path.join(dir,'state'),'--json','--once'], {env: {CX_SSH_SOCKET: socketPath, CX_SSH_HOST: 'fixture'}});
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.events.map(item => item.event), ['baseline','end']);
});

test('remote file watch reads a quoted path and detects matching new lines', async t => {
    const dir = temporary(t);
    const socketPath = path.join(dir, 'bridge.sock');
    const file = path.join(dir, "results 'quoted'.txt");
    const bridge = net.createServer(socket => {
        socket.on('data', data => {
            const request = JSON.parse(data);
            assert.equal(request.op, 'watch');
            const output = execFileSync('/bin/sh', ['-c', request.command], {timeout: 1500});
            socket.end(JSON.stringify({type: 'watch', status: 0, out: output.toString('base64'), err: ''}));
        });
    });
    bridge.listen(socketPath);
    await once(bridge, 'listening');
    t.after(() => bridge.close());
    const args = ['file','--host','fixture','--path',file,'--grep','ready',
        '--state',path.join(dir,'state'),'--json','--once'];
    const env = {CX_SSH_SOCKET: socketPath, CX_SSH_HOST: 'fixture'};
    assert.deepEqual((await run(args, {env})).events.map(item => item.event), ['baseline']);
    fs.writeFileSync(file, 'ready\n');
    const {events, status} = await run([...args,'--until-match','^exists '], {env});
    assert.equal(status, 0);
    assert.deepEqual(events.map(item => item.event), ['appeared','line','end']);
    assert.equal(events[1].data.text, 'ready');
});
