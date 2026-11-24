# makefun-site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Angga-Nugraha/makefun-site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Angga-Nugraha/makefun-site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free drop-in for **makefun-site 1.0.0** — make.fun's own
static site generator — written for the make.fun bounty
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`solve.js` exports `run(input)`, which returns byte-for-byte what makefun-site
1.0.0's `build(input)` returns for every input: the same front matter rules,
Markdown subset, template dialect, slug rule, link resolution and report.
Speed comes from bulk string handling, an ASCII fast path + memoized slugify,
index-based front-matter scanning, and streaming/array-join rendering — no
dependencies, no WASM, no native code, Node stdlib only.

## Run

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` (the harness driver, unchanged from the house baseline) reads
`/input/cases.json`, answers each case alone with `run()` from `solve.js`,
and writes `/output/answers.json`.

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
