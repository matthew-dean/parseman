---
# Not linked from the sidebar — this is a writing guide for contributors, not a guide page.
---

# Docs voice

A style guide for everything under `docs/`. If a page reads like a spec, it's wrong.

## The voice in one line

**A friendly expert explaining something they find genuinely interesting, to a smart
person who hasn't thought about parsers much.**

Light. Readable. A little playful. Not zany — no punchlines, no memes, no exclamation
marks doing emotional labour. The whimsy is in the *rhythm* and the occasional wry aside,
not in jokes.

## Do

- **Lead with the point.** First sentence of a section says what the thing is or why you'd
  care. Mechanism comes after.
- **Short sentences.** If a sentence has three clauses and two em-dashes, it's two
  sentences wearing a trenchcoat.
- **Concrete over abstract.** "Parsing a 150 KB stylesheet" beats "at scale."
- **One idea per paragraph.** Three or four sentences, then a break.
- **Use "you."** The reader is doing something; talk to them.
- **Show code early.** A ten-line example is worth two paragraphs of description.
- **Admit tradeoffs plainly.** "This is slower, and here's when that matters" builds more
  trust than a hedge.

## Don't

- **Don't stack qualifiers.** "deliberately, intentionally, and by design" is one word.
- **Don't write for the compiler.** Internal constant names, PR numbers, issue links, and
  file paths belong in code comments and `notes/`, not in a guide page. Nobody reading
  "how do I parse a config file" needs to know which GitHub issue was closed unimplemented.
- **Don't bold for emphasis mid-sentence** more than once a paragraph. Bold is a signpost,
  not a highlighter.
- **Don't sell.** State what it does and let the reader conclude. Every "crucially,"
  "unusually," and "best-in-class" spends credibility.
- **Don't name-drop.** See below.

## Examples must use languages people know

Every illustrative example — in prose, in code, in a benchmark caption — should use a
language the reader has already met:

**JSON, CSV, CSS, JavaScript, Markdown, SQL, GraphQL, TOML, HTTP, a `.env` file.**

The repo has working grammars for most of these in [`examples/`](https://github.com/matthew-dean/parseman/tree/main/examples).
Reach for those.

**Never** illustrate a concept with a language the reader has to go look up. If a measured
claim genuinely comes from a niche grammar, describe it by shape — "four CSS-superset
dialect grammars" — rather than by name, or introduce the name once, in a clause, with
what it is.

The same goes for internals of *other* projects. "Less's `OperationTop` rule" means
nothing to anyone who hasn't read Less's parser. Describe the language behaviour instead:
"in CSS-ish languages where `/` only divides inside parentheses."

## Length

If a guide page is over ~250 lines, it's probably two pages, or it's a reference page
pretending to be a guide. Deep internals go under `docs/design/`; the guide links to them.

## The test

Read the first paragraph of any page out loud. If you run out of breath, or you sound like
a changelog, rewrite it.
