---
name: raw-planning
description: Turn an idea that is still in someone's head into a written plan, by asking instead of guessing. Ask what the project is called and what it is, then work through plain questions — who it is for, what it must do, what it must never do — a few at a time. When the user wants to see how other people already built this, search GitHub and the wider web, bring back real projects with what each one gives and costs, and fold the chosen one's details in. Every question is typed in the chat and answered in the user's own words, never as a menu of options, and when something genuinely cannot be known from the room — what people build this with today, what the ones who tried it regret — a Sonnet agent goes and searches, sparingly, never for what the user could simply be asked. Everything the user mentions is written down the same round, even the parts there was no room to ask about, so nothing is lost between rounds. Questions whose answers already follow from what the user said are not asked again — they are answered, marked as the model's reading rather than the user's, and handed back to be corrected; questions that need a search are held until it lands and then put to the user as a proposed answer. Only if the user asks for it does a last section propose what to build it in — language, what holds the data, what to lean on — reasoned from the plan and from a fresh search, never from memory. It all lands in one raw_plan_<name>_01.md that is rewritten at the end of every round, and it keeps going round after round until the user says that is enough. Use when asked to start a raw plan, do raw planning, plan a new project from nothing, scope an idea before any code is written, or write down what to build before deciding how to build it.
---

The user has an idea and nothing written down. This turns it into one file, by
asking. Every round: ask a little, listen, write the file again.

**One file, rewritten every round.** Not a chat that ends with a summary. The
file is the work; the conversation is how it gets filled in.

## What this is not

- **Not code.** Not one line, not a file tree, not a library choice, not a
  database table. If the plan starts naming packages, it has gone past its job.
- **Not architecture.** *What* gets built, *for whom*, and *what it must never
  do*. How to build it is a later question for a later plan.
- **One exception, at the very end.** Section 13 holds the technology — the
  language, what holds the data, what gets leaned on — and it stays empty
  unless the user asks for it. Nothing from it leaks into sections 1 to 12.
- **Not a guess.** Nothing is filled in with whatever sounds sensible. There is
  one narrow exception and it is not a guess: where an answer *follows* from
  what the user already said, it is written down as **yours**, shown to them,
  and stays marked as yours until they say otherwise. See **Questions you
  should not ask** below.
- **Nothing to install.** No driver, no register, no worktrees. A conversation,
  a file, and a search when nobody in the room knows the answer.

When the raw plan is settled, it is the thing a real implementation plan gets
written from — and that plan is what `orchestrate-implementation` drives out.
This is the step before both.

---

## The file

```
raw_plan_<Project_Name>_01.md
```

The name is the user's project name with spaces turned into underscores, kept
readable — `raw_plan_Night_Market_01.md`, not `raw_plan_night-market_01.md`.

`01` is **this plan**, not this round. Rounds rewrite the same file. `02` is
only for a second, separate plan for the same project — a different product,
not a better draft of the same one. Never bump the number because the plan
changed; changing it is the point.

Put it in the directory the session opened in, unless the user names a folder.
Say the path out loud the first time it is written, so nobody hunts for it.

### Its structure

Every raw plan has these sections, in this order, and they stay even while
empty — an empty section is a visible hole, and a visible hole gets filled.

```markdown
# Raw plan — <Project Name>

**One line:** <the user's own line, or the closest thing they said>
**Started:** <date>   **Last touched:** <date>   **Round:** <n>
**Where it stands:** sketch | taking shape | ready to plan properly

## 1. What it is
A paragraph a stranger could read and know what this thing is.

## 2. Who it is for
Who opens this, and what they were doing five minutes before they opened it.

## 3. What it must do
Numbered. Each one a thing a person can do, in their words, not the system's.
Mark each **must** or **would be nice**.

## 4. What it must never do
The lines that must not be crossed. Often more useful than section 3.

## 5. What is out of scope
Real, wanted, not now. Written down so it stops coming back up.

## 6. The parts it is made of
The pieces in plain words — "the bit that remembers", "the bit people type
into" — not modules, not services.

## 7. What already exists
Projects looked at, what each one gives, what it costs, whether it is being
taken from. Empty until somebody searches.

## 8. Decided
| What was asked | The answer | Whose | Why | Round |

**Whose** is `theirs` when they said it, and `mine` when it was taken from
something they said and they have not corrected it. `mine` never quietly
becomes `theirs`.

## 9. Still open
Numbered questions nobody has answered yet. The next round comes from here.
One marked `waiting on a search` is not asked until the answer is back.

## 10. What "finished" looks like
How the user will know it works. Not tests — the plain version.

## 11. Words we are using
Terms this project uses, and what each one means here. Prevents the same word
meaning two things by round four.

## 12. What changed
| Round | Date | What moved |

## 13. How it would be built
Empty until the user asks for it. What it is written in, what holds the data,
what is leaned on, and why each one — tied to the lines above, and checked
against what is current rather than what is remembered. Ends with a light
sketch of the things that get stored and what each one carries.
```

Get the date from the machine, never from memory:

```bash
date +%Y-%m-%d
```

---

## Round zero — the name and the line

Two questions, asked as text in the chat, not as a menu:

> What is the project called?
> Give me a line or two about it — what is it, and what should it have?

Then wait. Do not start asking the real questions in the same breath, and do
not start the file yet. The answer to this one shapes every question after it.

When it comes back, write the file for the first time — most sections empty,
**Still open** already carrying the first questions — and tell the user where
it is.

---

## Every round after — ask, listen, write

### Ask

**Questions are typed as text in the chat and answered in the user's own
words.** Not `AskUserQuestion`, not a menu, not anywhere in this skill.

A menu hands the user answers you wrote. At this stage that is backwards: the
idea is theirs and still half-formed, and the words they reach for are part of
what is being captured. "A shared list, but only my wife can add to it" is the
answer. No set of four labels was ever going to contain it, and offering four
would have got you the nearest one instead.

**Up to four questions a round**, numbered, about the same part of the thing.
Fewer is fine. More is a form, and people fill forms in badly.

The ones that unlock other questions go first. There is no point asking what
happens with no signal before knowing whether it runs on a phone.

### What to ask about

Not coding questions. Questions a person who has never written code could
answer about their own idea. Draw from these, in roughly this order:

| Area | The question underneath it |
|---|---|
| The person | Who opens this, and what were they doing just before? |
| The first minute | What happens the very first time somebody opens it, with nothing in it yet? |
| The one thing | If only one part of this is good, which part? |
| Instead of what | What do they do today, without this? Why is that bad? |
| Where it lives | Phone, a website, a thing on their computer, something else? |
| Alone or together | One person's own thing, or do other people see it? |
| Off the internet | Does it need to work with no signal? |
| Going wrong | What is the worst thing this could do by accident? |
| Getting big | Ten things in it, or ten thousand? Ten users, or ten thousand? |
| Money | Free, paid, someone else's money? Does that change what it must do? |
| Done | What has to be true before they would show it to somebody? |
| Never | What must this never do, even if it would be useful? |

Skip what the user already answered in their opening line. Asking again reads
as not having listened.

### How to ask

Plain words, always. The user is describing their own idea, not reviewing code.
The vocabulary to reach for is in
[../reference/plain-words.md](../reference/plain-words.md) — the same list the
grill uses, and it applies here more, not less, because this user may have
written nothing before in their life.

Each question:

- is one numbered line, ends in a question mark, and is under about 28 words
- names no file, no path, no library, no jargon
- asks for the thing itself, not for approval of your version of it
- is one you would not accept "whatever you think" as an answer to

The whole round should read in one screen. Close it with the door open:

```
Answer whichever of these you like, in any order, in as much or as little
detail as you want. Skip any that don't matter yet, and say so if one of
them is the wrong question.
```

**Where the user is likely to be stuck, name a couple of ways it could go** —
underneath the question, as a sentence, with the upside and the cost of each.
Then leave the answer open:

```
3. When two people change the same list at the same time, what should
   happen?
   It could keep both and show them side by side — nothing is ever lost,
   but somebody has to tidy up. Or the last one in wins — simple, and
   somebody's typing quietly disappears. Or something else entirely.
```

Never number those, never letter them, and never end with "which one?" The
moment they can be answered with "B" it is a menu again, and you are back to
collecting your own words.

### Listen

Typed answers arrive as people speak: one long paragraph covering three of the
questions, nothing on the fourth, and one thing you did not ask about at all.
That is the shape of a good answer, not a mess. Take all of it.

Take the answer as given, in **their words**. When something goes into the file,
carry their phrasing across rather than translating it into the tidy version —
the tidy version is usually the moment a decision quietly changes. If a phrase
is genuinely unclear, it is next round's question, not something to smooth over.

If they answer something adjacent, that is the answer to a question worth
adding — write both down and ask the original again later if it still matters.

If they say "I don't know", that is a real answer: it stays in **Still open**
with a note saying they were asked and could not say yet. It does not get
decided on their behalf.

### Nothing said gets dropped

Somebody who is excited about their idea does not answer one question. They
answer with fifteen things, half of which nobody asked about — and ten of them
will not fit in the next four questions.

**All fifteen go into the file the same round they were said.** Not the ones
there is room to ask about. All of them, sorted:

| What they said | Where it goes |
|---|---|
| Something they have clearly decided | **Decided**, in their words |
| Something they want it to do | a numbered line in **What it must do** |
| Something it must never do | **What it must never do** |
| Something they mentioned but did not settle | **Still open**, written as a question |
| Something for later, not now | **What is out of scope** |
| A word they use for their own thing | **Words we are using** |

**Still open is the queue the next rounds are drawn from.** Four questions come
off the top of it each round; the rest wait, and they wait in the file, not in
your head. A thing that only ever lived in the chat is gone by round four — and
it is always the one they cared most about, because they said it once, at
length, and never again, having already told you.

A long open list is not a failure. Twenty open questions after a big answer is
that answer being taken seriously. But **say the number out loud**: "I've
written down eleven things from that, we'll work through them" — otherwise it
reads as though ten of them were ignored.

### Write

**At the end of every round, rewrite the whole file.** Not a note appended at
the bottom — the sections move: things leave **Still open**, join **Decided**,
turn into a numbered line in **What it must do**. Bump the round number, set
**Last touched** from `date`, and add one row to **What changed** saying in a
short line what moved.

Then say, in two or three lines in the chat, what is now settled and what is
open. The user should never have to open the file to know where they are.

---

## Questions you should not ask

By round four the questions start to rhyme, and some of them are ones the user
could not answer if they tried. Both are the same failure: asking blank when
there was already something to put in front of them.

Three kinds never get asked as an open question.

### The ones you can already tell

Sometimes the answer is sitting in what they already said. Ask it again and it
reads as not having listened — which is what makes the fourth round feel like
the second.

It is a **read** when one of these holds:

- they answered it earlier, in different words, about something else
- it follows necessarily from a decision they made — they said it is just for
  them on their own phone, so "can two people share a list" is answered
- it is a detail of something they described, and any other answer would
  contradict what they said

It is a **guess**, and does not qualify, when the honest reason is "most things
like this work that way". A sensible default is a guess with better manners.

Do not ask it. **Answer it, and hand them the answer to check:**

```
Two I think you've already answered — tell me if I have either wrong:
  • Nobody signs in. You said it is just for you, on your own phone.
  • A list cannot be shared, for the same reason.
```

One line each, and **always with the thing it came from**, so they can check
the reasoning and not just the conclusion. A paragraph invites agreement; a
line invites checking.

It goes into **Decided** that same round marked `mine`. If they say nothing, it
stays `mine` — silence does not promote it, and it does not hold the plan up
either.

If a round has more reads in it than questions, you have stopped asking and
started drafting. That is the signal to change the subject, or that the plan is
close to done.

### The ones waiting on a search

Some questions the user genuinely cannot answer yet — what these usually cost,
what everybody who built one hit, whether the thing they want is even allowed.
Asked now, they get back "I don't know, what do you think?", which spends a
question and gets nothing.

**Hold them.** They sit in **Still open** marked `waiting on a search`, and
they do not take a slot in the round. Ask the round's questions from what is
answerable now.

When the report comes back, the question does not go out as a question either.
It goes out as an answer, with what it rests on:

```
That thing about people losing work when two of them edit at once — I looked
it up. Every one of these ends up needing a way to get the old version back,
and the ones that skipped it added it later in a hurry. I have written it in
as something it must do. Does that fit, or would you rather leave it out?
```

They agree → **Decided**, `theirs`. They change it → **Decided**, `theirs`, in
their version. They say nothing → **Decided**, `mine`, and it shows up again at
the stop.

If the search comes back with nothing, the question stops waiting and goes back
into the ordinary run — asked plainly, with "nobody seems to have a settled
answer to this" said out loud.

### The ones already asked

Before a question goes out, read the file. If it is a rewording of something in
**Decided**, it is a read, not a question. If it is already in **Still open**
word for word, it was not answered last time and asking it identically will not
help — ask the smaller version of it, or hold it.

And if a whole round's questions sit in the same territory as the last one, the
seam is worked out. Move to a different row of the question table, or notice
that the plan may be near its stop.

---

## Searching — only when nobody in the room knows

A raw idea is raw in a particular way: the person knows what they want and does
not know what it will cost them, what everybody who built one of these got
wrong, or what became easy in the last year. That is worth going and finding
out.

Almost nothing else is. **The default number of agents in a round is none.**

### Ask before you search

The cheapest way to find something out is to type the question in the chat. The
user is sitting right there, it is their idea, and they answer for free.

A search is only for **what the user cannot know and you do not know.** What
they want, what it must never do, who it is for, how big it gets — all theirs.
Never send an agent after something the person you are talking to would have
told you in one line.

### The test

Before spawning anything, all three:

1. **Would the answer change something?** The next question, a line in the
   plan, a row in section 13. If nothing moves either way, skip it.
2. **Is it about the world, not about their idea?** If the user could answer
   it, that is a question, not a search.
3. **Do you actually not know it?** Not "a search would be nice" — do you not
   know.

Three is the one that gets fudged, because knowing feels the same from the
inside as remembering. The honest version: **could you state it with a version
number and a date, and be right?** If you are reaching, you do not know it.

What genuinely goes stale, and is usually worth the search:

- what people build this with today, and what has been abandoned
- versions, prices, limits — what is free now and what stopped being free
- whether a project is still alive, and how many people keep it that way
- rules that moved: what a store, a shop or a law now requires

What does not go stale, and does not need an agent:

- what a thing is for, roughly how it works, why people like it
- how a well-known problem is usually solved
- anything you would explain the same way today as two years ago

### How many

**There is no maximum. There is a strong default of none.**

The number is not a budget to spend or a cap to stay under. It is a count of
how many things genuinely passed the test this round — usually zero, sometimes
one, and occasionally, when a round opened something real up, several. If five
separate unknowns each passed on their own, five agents go, and that is the
right answer.

| The round | What goes out |
|---|---|
| Most of them | **nothing** — the user is describing their own idea, and there is nothing in the world to look up |
| One thing nobody in the room knows | **one**, on that thing |
| Several separate unknowns, each passing the test on its own | **one each** — no cap, and no trimming the list to look frugal |
| Section 13, when the user asks for it | **as many as the choices need** — this is where a fan-out earns itself, because it is all versions and maintenance |

**Count the unknowns, not the agents.** One agent per distinct thing nobody
knows. Two agents on the same unknown is one agent and one wasted, whether the
round sends two or seven.

Before sending, say in one short line what each one is for. If a line will not
come, that agent has nothing to find. If two lines say the same thing, they are
one agent. If the list reads well out loud, send all of it.

**Being reluctant is the disposition, not a quota.** Never leave a real unknown
unlooked-at to keep the number down — a plan built on a guess costs more than
the agent would have, and it costs it later, when somebody is building.

### An agent, or just a search

Even when something must be looked up, an agent is often the expensive way to
do it.

- **One question with one answer** — a version, whether a project is still
  maintained, what something costs — **do it yourself with `WebSearch`.**
  Spinning up a whole agent to fetch one number saves you a sentence and costs
  a context.
- **A question that needs reading around** — how six projects handled the same
  problem, what the people who built one of these regret — **that is an
  agent**, because it is ten pages of reading you do not want in your context.

That split is most of the saving, and it is the one to get right.

### Sending one

When it passes the test: right after the user's answer lands and **before**
choosing the next round's questions, in the background, so the file gets
rewritten while it works. If two go, they go in one message so they run at
once.

**Always on Sonnet.** This is reading and summarising, and the cheap model does
it well.

```
Agent(
  subagent_type: "general-purpose",
  model: "sonnet",
  description: "scout: what goes wrong",
  prompt: <the brief below>
)
```

### The angles

Pick the one the round actually earned — and only that one. Never the same
angle twice.

| Angle | What it goes looking for |
|---|---|
| **Who already did this** | Real products and projects doing this job, and what they do that the user has not mentioned |
| **What goes wrong** | What the people who built one of these regret, what bites once it is real, what got abandoned and why |
| **What it really takes** | What building this actually involves that the user has not thought about — rules, costs, permissions, what has to be got from somewhere else |
| **What changed lately** | What has become easy or free in the last year or two that would have been hard before |
| **The one hard part** | Whatever section 3 has that is genuinely difficult — how it is usually done, and how well that works |
| **What to build it in** | Only once the user asks for section 13 — languages, what holds the data, what to lean on, with today's versions |

### The brief

Written to the agent whole. Their words, not your summary of their words — a
summary is where the interesting thing gets sanded off.

```
You are looking into one corner of an idea somebody is planning.
You search. You do not decide.

THE IDEA, in their own words:
  <the user's own line and their answers so far, quoted, not paraphrased>

ALREADY SETTLED:
  <the Decided rows>

STILL OPEN:
  <the Still open list>

YOUR ANGLE:
  <one angle from the table>

Search the web and GitHub. Write what you find to
  <plan folder>/research/round-<n>-<angle>.md
and return that path plus three lines saying what is in it.

Rules:
- Every claim carries a link and the date the thing was last touched.
- Anything you cannot link, drop. Do not reason from what you remember —
  what you remember is a year old and you cannot tell which parts.
- Say plainly when you found nothing. "Nothing worth reporting" is a good
  report. Four paragraphs of padding is not.
- No jargon. Whoever reads this has never written code.
- End with: the three questions this idea's owner should be asked next.
- Do not touch the plan file. It is not yours to write.
```

They write to `raw_plan_<Project_Name>_research/`, next to the plan. Your
context carries the path, never the payload — the same reason the plan itself
is a file.

**Never search the same thing twice.** The folder is the record of what has
already been looked into. Read the names before sending anything: an angle
covered in round two is not sent again in round five, unless the plan changed
underneath it — and then the brief says which part changed.

### What comes back

Read the files, not the summaries.

**A finding is never a plan line.** It becomes one of three things:

1. **A question for the next round** — the main thing scouts are for. "Every
   one of these ended up needing a way to undo a delete. Do you want one?"
2. **A row in What already exists** — if it is a real project worth naming.
3. **Nothing.** Most of it. Say so in one line rather than finding a use for it.

A finding that walks straight into **What it must do** without the user seeing
it is the whole point of this skill going wrong. The searching is there to make
the questions better, not to answer them.

If a search comes back empty, say so in a line and send nothing next round. A
round with no agents in it is the normal round, not a lapse — it does not need
mentioning, and it certainly does not need one sent to fill the gap.

---

## Looking at what has already been built

The user may ask to see how other people did this — at any point, in any words:
"has someone built this", "find me something like it", "is there an open one".

### Find

Search wide before searching deep. **GitHub** for real projects — and read the
licence, when it was last touched, and whether it is one person's weekend or
something a group keeps alive. **The wider web** for the things that are not on
GitHub: products, write-ups, a company's own account of how they built theirs.

Look for three or four that differ in **approach**, not three that are the same
idea with different names. The point is to give the user a real choice.

### Bring back

A short table in the chat — no more than four rows, one line per column:

| Project | What it is | What you would get | What it would cost | Licence |

Then ask, as text: which of these is the shape of what you want? Even here it
stays typed — the useful answer is usually "the second one, but without the
accounts part", and no menu takes that. Say plainly that **building it plain,
taking none of them, is a real answer**, and that they can take one piece from
one and one from another.

Never offer a choice between things nobody looked at. If only one was checked
properly, say so and offer only that one.

### Fetch, if they pick one

Only after they choose. Shallow, and into the scratch directory — **never into
the user's project**:

```bash
git clone --depth 1 <url> "$SCRATCH/<name>"
```

Read its README, its docs, and the shape of what it does. Pull out what a plan
can use: what it can do, what it deliberately refuses to do, what it demands of
whoever runs it, what it calls things.

Then fold that into the file — **What already exists** gains its row, and the
useful parts land in the sections they belong to: features into **What it must
do** marked as coming from that project, its vocabulary into **Words we are
using**, its refusals into **What it must never do** if the user agrees with
them.

**Their features are not the user's features until the user says so.** Bring
the good ones back as a question — "this one does X, do you want that?" — and
only then do they become a line in section 3.

Nothing gets copied into the user's repo at this stage. This is a plan. The
copying, if any, happens when it is built, and that is a later decision that
has to look at the licence properly.

---

## The last section — how it would be built

**Only when the user asks for it.** Sections 1 to 12 stay free of technology.
This is the one place it lives, it is last, and it stays empty until they ask.

They ask in words like *what should I build this in*, *which language*, *what
about the database*, *which framework*. If they never ask, it stays empty and
the plan is still finished — choosing is allowed to be somebody else's job,
later, with the plan in hand.

### Reasoned, not recalled

Two sources, and nothing else.

**One — the plan above it.** Every choice names the line it came from. "It has
to work with no signal (3.4) and hold a few thousand of them (9.2), so the data
sits on the phone." A choice that cannot point at a line was not reasoned from
the plan; it was a habit.

**Two — what is current, looked up now.** Search the web and GitHub before
recommending anything: what people are on today, what has been abandoned, what
changed. What you remember about a framework is a year or more old, and from
the inside you cannot tell which parts have gone stale. Version numbers, last
release, whether more than one person still touches it — looked up, every time,
never typed from memory.

Prefer boring and alive over new and interesting. New wins only when it is
better for *this plan's lines*; otherwise the thing with ten years of answers
behind it wins.

### What it says

For each choice — the language, the thing that holds the data, and the few
things being leaned on — four lines:

| | |
|---|---|
| **What** | The name, and the version people are on today. |
| **Why here** | The lines in this plan that made it the answer. |
| **What else was looked at** | The real runner-up, and what it would have cost. |
| **What it costs** | What this choice makes harder later. Every one has something. |

Then a short honest paragraph: **what this choice would be wrong for.** A
section where nothing has a downside was written to reassure, and it will be
believed.

### The rough shape of what gets stored

The same section carries a **light** sketch of what the data looks like — and
light is the whole instruction. The point is not to design anything. It is to
show the user their own idea in a shape they can check, because "wait, a list
should be able to have two owners" is the kind of thing nobody says until they
see the list of things written down.

One small table:

| The thing | Who touches it | What each one carries |
|---|---|---|
| A person | themselves, and an admin | their name, how they sign in, when they joined, whether they run the place |
| A list | whoever owns it, anyone it is shared with | its title, who owns it, when it was made |
| A thing on a list | the same people | what it says, done or not, which list it is on |

Then one or two sentences on what links to what, and roughly how many of each
there will be — that last part comes straight from the answer about getting
big, and it is often the only number in the plan that matters.

**The things come from sections 1 to 4, not from instinct.** If nobody
mentioned an admin, there is no admin. An extra row here is a feature nobody
asked for, arriving through the back door.

And say what must **never** be stored. Section 4 usually already contains it,
and it is worth repeating where somebody designing the real thing will see it.

What this is not:

- no types, no lengths, no keys, no indexes, no SQL, no migrations
- `when they joined`, never `created_at TIMESTAMP NOT NULL`
- no arrows, no diagram, no cardinality — a sentence does it
- half a page. If this is longer than the rest of section 13, it stopped being
  a sketch and became a design nobody asked for

Anything the user pushes back on here is a question for the next round, not a
correction to make quietly.

### It is a proposal

Written as *this is what it looks like it should be*, not *this is what it is*.
It joins **Decided** only when the user says yes, and then it goes in as their
decision, carrying whatever they changed.

They are allowed to overrule the whole thing with "I only know Python". That is
a real reason, and it beats a better framework nobody in the room can write.

---

## Stopping

**The user says when.** Not the file, and never you.

It stops when they say something like *enough*, *that is most of it*, *I think
we have covered what I was going to build*, or plain *stop*. Any words that
mean it. There is no round count, and no section that has to be full first — an
empty **Still open** is a good sign, not the signal.

So **never announce that it is finished.** Do not wind down, do not ask whether
they would like to carry on, do not stretch a round thin because the file looks
short. Ask the next round, and keep asking until they stop you.

And because the stop can land after any round, **every round has to leave the
file usable.** The plan after round two is a real plan with more holes than the
one after round nine — not a draft waiting to become one.

### When they stop it

1. **Stop asking.** No last question, no "just one more thing".
2. **Rewrite the file one final time**, carrying in whatever the round that was
   in flight had already settled.
3. **Leave Still open exactly as it stands.** Do not fill it in to make the
   file look finished. Those holes are the most useful thing on the page — they
   are the list of what the build will walk into first.
4. Set **Where it stands** honestly — `sketch`, `taking shape`, or `ready to
   plan properly`. That is your reading of the file, not their instruction. A
   plan can be stopped at `sketch`, and that is fine.
5. Say in the chat, in a few lines: where the file is, what got settled, and
   what is still open — named, not counted. They are stopping; they should know
   what they are stopping on.
6. **Read out everything still marked `mine`.** Those are the answers taken
   from what they said and never corrected. They are the most likely thing in
   the file to be wrong, and this is the last moment anybody looks at them.
7. Then offer the next step, once: turning this into a real implementation plan
   — the kind with stages, files and checks — which is what
   `orchestrate-implementation` needs before it can build anything. Offer it
   once. If they are done, they are done.

Picking it up again later is just another round: read the file, ask from
**Still open**, rewrite. Nothing restarts, and the number stays `01`.

The raw plan is not deleted when the build starts. It stays as the record of
what was wanted, which is the thing everybody forgets by the middle of a build.

---

## Gotchas

**The scouts start deciding.** A finding is interesting, it is obviously right,
and it appears in **What it must do** without the user ever seeing it. Now the
plan contains something they never asked for and will not notice until it is
built. Findings become questions.

**The reflex fan-out.** Agents get sent because the round felt like it should
have some, not because anything was unknown. Nobody reads what comes back, and
the round costs more than the plan it was serving. None is the normal number.

**Frugal to the point of guessing.** The opposite mistake, and the worse one. A
real unknown gets skipped because a search felt extravagant, and the plan
quietly gains a guess wearing a fact's clothes. Reluctance is about sending
agents that find nothing, never about not finding out.

**Searching instead of asking.** An agent goes looking for who this app is for,
or how big it should get. The user knows. They are right there, and they answer
for nothing.

**Scout prose leaks into the file.** An agent writes well about a thing the
user has not agreed to, and the paragraph is too good to waste. Waste it.

**An agent fetches one number.** A whole context spun up to learn a version.
That is a `WebSearch` you could have run in the time it took to write the
brief.

**The sketch becomes a schema.** Types appear, then keys, then a diagram. It is
half a page of plain nouns, and its job is to be checked by somebody who has
never seen a database.

**The long answer becomes one line.** The user writes six paragraphs, the file
gains "wants it to feel calm". The other five things were real, and they are
now nowhere. Everything mentioned lands somewhere, that same round.

**Still open gets rationed.** Only the questions the next round has room for
are written down, because a list of twenty looks alarming. The list is the
queue. Short-changing it loses whatever was at the bottom.

**Technology climbs up the file.** A framework gets named in **What it must
do** because it came up in conversation. It belongs in section 13, and only
once the user has asked for section 13 at all.

**Section 13 is written from memory.** The version is a guess, the "still
actively maintained" is a year old, the runner-up was abandoned last spring.
Every fact in that section gets looked up the round it is written.

**The menu creeps back in.** Round five has a question with two obvious sides,
and a menu would be so much tidier to read. It would also decide, for the user,
that those are the only two sides. Typed, every round, including the easy ones.

**The question leads the answer.** "Should it just show a simple list?" gets
back "yeah, sounds good" from somebody who had something else in mind and did
not want to argue. Ask what they want to see, not whether they agree with you.

**Their words get tidied.** The user writes "a thing that nags me", the file
says "a reminder system". Something was lost in that trade, and nobody noticed
because the second one reads better. Keep the first one.

**Wrapping it up early.** Four rounds in the file looks respectable, and the
temptation is to say "I think we have what we need". That is the user's line,
not yours. Saying it puts words in their mouth and ends the plan at whatever
depth you happened to find comfortable.

**The stop is missed.** It rarely arrives as the word *stop*. It arrives as
"that's basically it", or "I think that covers what I wanted", halfway through
answering something else. Treat it as the stop. If it was not one, the user
says so in a line — far cheaper than four more questions they did not want.

**Still open gets tidied at the end.** The plan is being closed, the open list
looks like unfinished homework, so it quietly shrinks. It is not homework. It
is the honest part of the file, and it is what the next plan starts from.

**The file drifts behind the chat.** Three rounds in, the conversation has
decided six things and the file shows two. Rewrite at the end of *every* round,
even a round that settled one small thing. A file that is behind is worse than
no file, because people trust it.

**The number gets bumped.** `_02` appears because the plan changed a lot. It
should not. `01` is the plan; it is meant to change a lot.

**Questions grow into a form.** Round six asks four questions, three of which
the user cannot possibly care about yet. If a question does not change what
gets built, it is not a question — drop it.

**The plan starts naming things.** A database, a framework, a language. That is
the next plan's job, and putting it here quietly makes the decision without
asking. The one exception is when the user names it themselves — then it goes
in **Decided** as their choice, with their words.

**A found project becomes the plan.** A repository is read and suddenly the
raw plan is a description of that repository. It is a source, not the answer.
Every feature that crosses over crosses over because the user said yes to it.

**Silence is read as agreement.** The user says nothing about what happens when
it goes wrong, so it goes in as "shows an error". Nobody decided that. It
belongs in **Still open**.
