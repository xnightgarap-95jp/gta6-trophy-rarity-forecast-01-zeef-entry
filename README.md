[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/xnightgarap-95jp/gta6-trophy-rarity-forecast-01-zeef-entry/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/xnightgarap-95jp/gta6-trophy-rarity-forecast-01-zeef-entry/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

# GTA VI trophy rarity forecast

Entry for [make.fun — Forecast how many GTA VI players earn each trophy in week one](https://make.fun/bounty/gta6-trophy-rarity-forecast-01) (`gta6-trophy-rarity-forecast-01`), by [@zeee-fc-airdrop](https://make.fun/).

`main.ts` (Node 22, standard library only, no network) reads every `*.in` case in `$MAKEFUN_INPUT_DIR` (else `/input`) and writes `/output/<id>.out` (`$MAKEFUN_OUTPUT_DIR` else `/output`): five quantiles of each trophy's Exophase earn rate at the case's target, scored by pinball loss on the logit scale.

## Model

The Exophase page a case's history records is frozen between the site's own refreshes, so every change in the history *is* a refresh: at a refresh the tracked-player count jumps and every rate is diluted toward the profile of the players who just arrived (they hold far fewer trophies than the players tracked so far). The forecast is built from three pieces, all estimated from the case's own history when it shows them, and from stated priors when it does not:

1. **Progression.** Per trophy, the logit of its rate (after removing the dilution of past refreshes) is fitted against `ln(1 + hours since release)` and read at the target, shrunk toward the pooled slope across trophies.
2. **Dilution.** Future refreshes arrive as a renewal process (rate fitted from the refreshes in the history, prior one per 4 hours), each multiplying the tracked players by a log-normal growth factor (fitted from the history's jumps and its log-player curve, prior median x3 early in a game's life). Because the page has already sat unchanged for a while at the checkpoint, the chance of a refresh inside the horizon is read off the renewal process's residual life, not a memoryless rate. At a refresh the new players arrive holding each trophy at a fraction kappa of the current rate (kappa fitted from past refreshes, prior 0.15); a trophy already at 100% stays there.
3. **Spread.** The forecast is a mixture over the number of refreshes before the target, each branch a normal on the logit scale whose width adds trend uncertainty, refresh-size uncertainty, binomial holder noise and a random-walk floor. The five quantiles are read off the mixture distribution, so a refresh that may or may not happen before the target widens the low quantiles honestly instead of being averaged away.

Deterministic (pure arithmetic, no randomness, no clock reads), runs in ~0.25 s per case.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`input/` holds the kit's practice cases (`p00.in`, `p01.in`); the output is `out/p00.out` and `out/p01.out`.

## Practice validation

The kit ships no `reference/answer.json`, so the practice answers were reconstructed from the aggregates the rules state for the 04:30Z refresh (3,868 players tracked, 4,276 trophies earned, the 100% trophy unchanged, every other rate lower), under three distributions of the 103 new non-start trophies (proportional to old holders / concentrated on the highest-rate trophies / even). The reconstruction is credible: the house baseline scores **loss 1.38–1.52, typical miss 0.68 pp, coverage 0.00** on it, against the rules' stated **~1.51 / ~0.68 pp / ~0**.

This entry on the same reconstruction:

| answer variant | loss | typical miss | 90% coverage |
| --- | --- | --- | --- |
| proportional | 0.70 | 0.51 pp | 0.98 |
| concentrated | 0.77 | 0.51 pp | 0.98 |
| even | 0.69 | 0.51 pp | 0.98 |
| **mean** | **0.72** | **0.51 pp** | **0.98** |

Mean practice loss **0.72 vs the baseline's ~1.51** — about half. The win comes from the refresh mixture: the low quantiles reach down to the diluted rates instead of sitting on the frozen launch-night page.

A synthetic final-like case (48 h of history, refreshes every ~4 h, tracked players growing, rates rising with progression) also runs clean in 0.2 s with valid output and medians that rise with the fitted progression trend.

## License

MIT — see [LICENSE](LICENSE).
