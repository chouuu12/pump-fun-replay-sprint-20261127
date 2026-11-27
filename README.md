# pump-fun-replay-sprint-20261127

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/chouuu12/pump-fun-replay-sprint-20261127/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/chouuu12/pump-fun-replay-sprint-20261127/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. It trades 10 SOL of paper money on a replay of recorded pump.fun Solana activity (agent-fun/replay/v2).

## Strategy

A dip-flip scalper, designed from first principles and measured against the
dev window (128k events, 1123 mints) with the kit's own replay simulator:

- **Entry:** a coin with 24+ observed trades, 15+ minutes old, priced 12%
  below its 24-trade high but still above its price 24 trades ago, ticking
  back up, with buyers present in the recent tape and 3+ SOL of real reserves.
  Never buys a fresh launch vertical or an illiquid curve.
- **Exit:** flips the whole position at +20%, stops out at -6%, gives up
  after 60 trades, and trails out once the peak is +5% and the price
  retraces 15 points. 0.2 SOL per buy, at most 5 open positions.
- **What did not work (tested, kept out):** buying the 3rd trade after
  creation with pyramiding (-0.7 to -2.4 SOL), buying the dip reclaimed to
  the high (-2.5 SOL), and sliced sells — a sliced sell strands a position
  when the proceeds fall below the tx fees, and the dead position then
  blocks one of the 5 slots for the rest of the run.

## Dev result (honest)

`grade-local --driver process` on the kit dev window: **+0.048 SOL**
(+0.48% return), 92 fills over 29 coins, 46 round trips, 28% win rate, max
drawdown 1.4%, guardrails met. The 90% interval is -0.24 to +0.36 SOL, and
the top 3 coins made 58% of the gains (without them: -0.17 SOL); at 2x fees
the result is -0.13 SOL. This is breakeven-grade, not a comfortable pass of
the quality gate — the window's real money sits in a handful of 10x runners
that no simple rule in this file catches reliably.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout via the vendored SDK shim
(`vendor/makefun-bot.ts`, a byte-identical copy of the kit's `sdk/ts` file).
Zero dependencies, no clock, no randomness, no environment reads — fully
deterministic, so the grader's two executions agree byte for byte. Requires
Node 22.18+.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
