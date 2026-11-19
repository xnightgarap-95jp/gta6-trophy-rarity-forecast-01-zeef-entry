# Readiness — gta6-trophy-rarity-forecast-01 (zeef entry)

## Entry

- Folder: `~/workspace/airdrop-tanpa-modal/makefun/gta6-trophy-rarity-forecast-01-zeef-entry/`
- Files: `main.ts` (Node 22, stdlib only), `README.md` (3 make.fun badges), `LICENSE` (MIT, xnightgarap-95jp 2026), this file.
- Account: @zeee-fc-airdrop. Repo name for badges: `gta6-trophy-rarity-forecast-01-zeef-entry`.

## Verification

- `node main.ts` on the kit practice input (`MAKEFUN_INPUT_DIR`/`MAKEFUN_OUTPUT_DIR` set): exits 0, ~0.25 s, writes `p00.out` + `p01.out` (55 rows each, 5 non-decreasing quantiles in [0, 100], ~2.8 KB each, under the 65,536-byte cap).
- Determinism: two runs byte-identical (`diff -r` clean).
- Syntax: `node --check` cannot parse `.ts` (it does not strip types); validated by running the program itself and by the kit's `check` command below.
- Kit check: `node cli/makefun.mjs check --kit . --repo <folder>` — see report (transcript checks run server-side at submit).
- Practice scoring: the kit ships no `reference/answer.json`, so answers were reconstructed from the rules' stated 04:30Z refresh aggregates (3,868 players, 4,276 trophies earned) under three variants; the reconstruction reproduces the stated baseline figures (loss ~1.51, miss ~0.68 pp, coverage 0). This entry: mean loss **0.72**, typical miss **0.51 pp**, 90% coverage **0.98** across the three variants (0.69–0.77 loss).
- Synthetic final-like case (48 h history, ~120 reads, refreshes every ~4 h, N 638 → ~4.8M, rates rising): runs in 0.2 s, valid output, medians rise with the fitted progression trend, wide honest spread for the 4.5-day horizon.

## Notes for the submitter

- Transcript-bundle competition (no live recording): bundle this session with the kit CLI; the parent handles bundling + submit.
- Do NOT edit any file in this folder after bundling — a post-bundle edit breaks the witnessed-content check (same failure mode as the GTA 6 entry's README edit).
