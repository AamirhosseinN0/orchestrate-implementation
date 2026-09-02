#!/usr/bin/env node
// Turn a Cursor agent's jsonl stream into something a person can watch.
//
// The raw stream is a firehose — thinking arrives token by token — and the log
// is written for machines. This reads that stream on stdin and prints a compact
// running account: what the agent said, what it ran, what came back. It is the
// same formatter whether it sits in the live pipeline or tails a log after the
// fact, so a run looks the same however you came to be watching it.
//
//   --key <name>   label each line, for when several runs share a pane
//   --quiet-think  drop the thinking summaries, keep actions and answers
//   --full         do not truncate command output

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const KEY = opt('--key', '');
const QUIET_THINK = args.includes('--quiet-think');
const FULL = args.includes('--full');

// Colour only when a person is actually looking at a terminal. Piped into a
// file or a task pane that strips escapes, this stays plain.
const TTY = process.stdout.isTTY;
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s), bold = (s) => c('1', s);
const cyan = (s) => c('36', s), green = (s) => c('32', s);
const yellow = (s) => c('33', s), red = (s) => c('31', s);

const t0 = Date.now();
const stamp = () => {
  const s = Math.floor((Date.now() - t0) / 1000);
  return dim(String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'));
};
const tag = KEY ? dim(KEY) + ' ' : '';
const say = (line) => { process.stdout.write(stamp() + ' ' + tag + line + '\n'); };

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
  return clip(kind.replace(/ToolCall$/, ''), 60);
};

let think = '';       // thinking deltas accumulate; one line per completed block
let lastWasBody = false;

function handle(ev) {
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') say(cyan('●') + ' ' + bold(ev.model || 'unknown model') +
        dim('  session ' + String(ev.session_id || '').slice(0, 8)));
      break;

    case 'thinking':
      if (ev.subtype === 'delta') think += ev.text || '';
      else if (ev.subtype === 'completed') {
        if (think.trim() && !QUIET_THINK) say(dim('· ' + clip(think, 100)));
        think = '';
      }
      break;

    case 'assistant': {
      const text = (ev.message?.content || []).map((p) => p.text || '').join('').trim();
      if (text) { say(bold('▌') + ' ' + clip(text, 300)); lastWasBody = true; }
      break;
    }

    case 'tool_call': {
      const [kind, call] = toolOf(ev.tool_call);
      if (!kind) break;
      if (ev.subtype === 'started') say(yellow('→') + ' ' + describe(kind, call));
      else if (ev.subtype === 'completed') {
        const out = findOutput(call);
        const code = out && out.exitCode !== undefined ? out.exitCode : null;
        const mark = code === 0 || code === null ? green('✓') : red('✗ exit ' + code);
        const body = out ? String(out.stdout || '') + String(out.stderr || '') : '';
        const lines = body.split('\n').filter((l) => l.trim());
        say('  ' + mark + (lines.length ? '' : dim(' (no output)')));
        const show = FULL ? lines : lines.slice(0, 6);
        for (const l of show) say(dim('  │ ') + clip(l, 200));
        if (!FULL && lines.length > 6) say(dim('  │ … ' + (lines.length - 6) + ' more lines'));
      }
      break;
    }

    case 'result': {
      if (ev.is_error) say(red('■ error') + ' ' + clip(ev.result || '', 300));
      else if (ev.result) say(green('■') + ' ' + clip(ev.result, 400));
      break;
    }
  }
}

// Line-buffered so a watcher shows work as it happens rather than at the end.
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let ev;
    // A line that is not an event is the stream stopping outside the protocol.
    // It is the most important thing on the screen, so it is never swallowed.
    try { ev = JSON.parse(line); } catch { say(red('■ ') + line.trim()); continue; }
    try { handle(ev); } catch { /* one odd event must not stop the watch */ }
  }
});
process.stdin.on('end', () => { if (buf.trim()) { try { handle(JSON.parse(buf)); } catch { say(red('■ ') + buf.trim()); } } });
