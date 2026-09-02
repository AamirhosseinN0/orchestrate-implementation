#!/usr/bin/env node
// Turn a Cursor agent's jsonl stream into something a person can watch.
//
// The raw stream is a firehose and the log is written for machines. This reads
// it on stdin and prints a compact running account: what the agent said, what it
// ran, what came back. Same formatter live or replaying, so a run looks the same
// however you came to be watching it.
//
//   --key <name>        label each line, for when several runs share a pane
//   --quiet-think       drop the thinking summaries, keep actions and answers
//   --full              do not truncate command output
//   --exit-on-result    stop once the run ends, instead of draining stdin
//
// --exit-on-result is for a watcher sitting on `tail -f`, which has no stop
// condition of its own and would otherwise follow a finished run forever. It is
// deliberately NOT used by the launcher: there the formatter shares a pipe with
// the `tee` writing the log, and exiting early would SIGPIPE the log short.

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const KEY = opt('--key', '');
const QUIET_THINK = args.includes('--quiet-think');
const FULL = args.includes('--full');
const EXIT_ON_RESULT = args.includes('--exit-on-result');

const TTY = process.stdout.isTTY;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s), bold = (s) => c('1', s);
const cyan = (s) => c('36', s), green = (s) => c('32', s);
const yellow = (s) => c('33', s), red = (s) => c('31', s);
const mag = (s) => c('35', s);

// Elapsed comes from the events' own clock when they carry one, so a saved log
// replays with the timings it actually ran at. Every event but `init` has a
// timestamp_ms; the wall clock is the fallback, which is what a live run with a
// missing stamp gets.
let t0 = null, lastTs = null;
const wall0 = Date.now();
const stamp = (ev) => {
  const now = (ev && ev.timestamp_ms) || null;
  if (now) { if (t0 === null) t0 = now; lastTs = now; }
  // A line with no clock of its own — a bare error tail — is stamped with the
  // last one seen. It is the moment the run stopped, and printing 00:00 there
  // hides the one timing anybody wants.
  const at = now || lastTs;
  const s = Math.floor((at && t0 ? at - t0 : Date.now() - wall0) / 1000);
  return dim(String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'));
};
const tag = KEY ? dim(KEY) + ' ' : '';
const say = (ev, line) => { process.stdout.write(stamp(ev) + ' ' + tag + line + '\n'); };

const clip = (s, n) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
};

// The shell result is wrapped in a success/failure branch; find the branch that
// carries the output rather than naming one.
function findOutput(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (typeof node.stdout === 'string') return node;
  for (const k of Object.keys(node)) { const hit = findOutput(node[k], depth + 1); if (hit) return hit; }
  return null;
}
// Any key ending in ToolCall is the payload; the set grows and the name is not
// load-bearing.
const toolOf = (tc) => {
  if (!tc) return [null, null];
  for (const k of Object.keys(tc)) if (/ToolCall$/.test(k) && tc[k] && typeof tc[k] === 'object') return [k, tc[k]];
  return [null, null];
};
const describe = (kind, call) => {
  const a = call.args || {};
  if (a.command) return clip(a.command, 160);
  if (a.path || a.file_path) return clip(a.path || a.file_path, 160);
  if (a.url) return clip(a.url, 160);
  return clip(kind.replace(/ToolCall$/, ''), 60);
};

let think = '';
let ended = false;

function handle(ev) {
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') say(ev, cyan('●') + ' ' + bold(ev.model || 'unknown model') +
        dim('  session ' + String(ev.session_id || '').slice(0, 8)));
      break;

    case 'thinking':
      if (ev.subtype === 'delta') think += ev.text || '';
      else if (ev.subtype === 'completed') {
        if (think.trim() && !QUIET_THINK) say(ev, dim('· ' + clip(think, 100)));
        think = '';
      }
      break;

    case 'assistant': {
      const text = (ev.message?.content || []).map((p) => p.text || '').join('').trim();
      if (text) say(ev, bold('▌') + ' ' + clip(text, 300));
      break;
    }

    // Transport trouble, which used to be dropped on the floor. The run that
    // died on a PING timeout reconnected six times first and the watcher showed
    // none of it — the one signal that predicted the failure.
    case 'connection':
      if (ev.subtype === 'reconnecting') say(ev, mag('~') + ' connection lost, reconnecting' + dim(' (attempt ' + (ev.attempt ?? '?') + ')'));
      else if (ev.subtype === 'reconnected') say(ev, mag('~') + ' reconnected');
      break;
    case 'retry':
      if (ev.subtype === 'starting') say(ev, mag('~') + ' retrying' + dim(' (attempt ' + (ev.attempt ?? '?') + (ev.is_resume ? ', resuming' : '') + ')'));
      break;

    // The agent asking for something — a web fetch, a permission. Auto-approved
    // under --force, but a chip reaching the network is worth seeing.
    case 'interaction_query':
      if (ev.subtype === 'request') {
        const q = ev.query || {};
        const inner = Object.values(q).find((v) => v && typeof v === 'object' && v.args) || {};
        say(ev, yellow('?') + ' ' + clip((ev.query_type || 'query').replace(/Query$/, '') + ' ' + (inner.args?.url || ''), 160));
      }
      break;

    case 'tool_call': {
      const [kind, call] = toolOf(ev.tool_call);
      if (!kind) break;
      if (ev.subtype === 'started') say(ev, yellow('→') + ' ' + describe(kind, call));
      else if (ev.subtype === 'completed') {
        const out = findOutput(call);
        const res = call.result || {};
        // An edit reports what it changed instead of stdout it never had.
        const edit = res.success && (res.success.linesAdded !== undefined || res.success.diffString);
        if (edit) {
          const s = res.success;
          say(ev, '  ' + green('✓') + dim(` +${s.linesAdded ?? 0}/-${s.linesRemoved ?? 0} ${s.path || ''}`));
          break;
        }
        const code = out && out.exitCode !== undefined ? out.exitCode : null;
        const mark = code === 0 || code === null ? green('✓') : red('✗ exit ' + code);
        const body = out ? String(out.stdout || '') + String(out.stderr || '') : '';
        const lines = body.split('\n').filter((l) => l.trim());
        say(ev, '  ' + mark + (lines.length ? '' : dim(' (no output)')));
        const show = FULL ? lines : lines.slice(0, 6);
        for (const l of show) say(ev, dim('  │ ') + clip(l, 200));
        if (!FULL && lines.length > 6) say(ev, dim('  │ … ' + (lines.length - 6) + ' more lines'));
      }
      break;
    }

    case 'result': {
      if (ev.is_error) say(ev, red('■ error') + ' ' + clip(ev.result || '', 300));
      else if (ev.result) say(ev, green('■') + ' ' + clip(ev.result, 400));
      else say(ev, green('■') + dim(' (ended with no text)'));
      ended = true;
      break;
    }
  }
}

function feed(line) {
  if (!line.trim()) return;
  let ev;
  // A line that is not an event is the stream stopping outside the protocol —
  // a loop detector, a transport error. It is the most important thing on the
  // screen, so it is never swallowed, and it ends the run.
  try { ev = JSON.parse(line); } catch { say(null, red('■ ') + line.trim()); ended = true; return; }
  try { handle(ev); } catch { /* one odd event must not stop the watch */ }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    feed(line);
    if (ended && EXIT_ON_RESULT) process.exit(0);
  }
});
process.stdin.on('end', () => { if (buf.trim()) feed(buf); });
