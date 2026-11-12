# REORG: Product and Technical Spec

*Buy the token, get hired by an AI boss. Miss your work, get laid off.*

Hackathon build on NEAR. Version 1.0.

## 1. Overview

**REORG** is a memecoin where the token is a job. An autonomous AI boss runs a company whose entire workforce is its token holders. Holders are employees automatically, with no signup. Every day the boss assigns a short, fun task. A script decides pass or fail. Passing earns a salary paid in NEAR from the company treasury. Missing work costs you pay and eventually gets you laid off. If the company's treasury runs dry, the company goes bankrupt and closes.

**Company:** Reorg Inc. **Ticker:** $REORG. **Tagline:** Hold the token. Get hired. Survive the reorg.

### Goals

- Explain the whole product in one sentence: *your token is your job, and your boss is an AI.*
- Make holding the token a daily activity, not a passive bet.
- Keep every consequence objective: pass or fail, decided by code, auditable onchain.
- Ship a working demo with one real NEAR contract and a live company-tower game.

### Non-goals

- No token launchpad, custom bonding curve, or complex tokenomics.
- No tasks that involve money (no sending funds, no price predictions).
- No subjective scoring by the AI.
- No anti-sybil system. Position is based on share of total supply, so splitting a bag across wallets gains nothing.

## 2. Core rules

1. **Hold the token and you are hired.** Employee status comes from token balance, not registration.
2. **Title comes from your share of total supply.** More supply means a higher title and a bigger payroll bucket.
3. **Pay comes from passing tasks.** Each day has a task with a binary result.
4. **Streaks raise your pay.** Consecutive passes add a bonus. A miss resets it.
5. **Layoffs are social, not confiscatory.** Your tokens are never touched. You lose salary eligibility for a week and get a public Laid Off status.
6. **The company can die.** A visible treasury and daily operating cost create real stakes.

## 3. Titles and payroll buckets

Title is based on percentage of total token supply held at the time of your submission.

| Title | Holds | Share of payroll pool |
| --- | --- | --- |
| Director | at least 3% of supply | 35% |
| Manager | at least 1% | 30% |
| Associate | at least 0.25% | 20% |
| Intern | at least 0.001% | 15% |

Holders below 0.001% are visitors, not employees. All thresholds are contract parameters. If a tier has no passers on a given day, its bucket goes to the reserve.

## 4. Tasks

### 4.1 Rules for every task

- **About 60 seconds**, doable from a phone.
- **Verified by code, never by opinion.** The AI writes flavor text. A function decides pass or fail.
- **Personalized per wallet.** Each wallet receives its own version of the puzzle, derived from a secret the boss commits to in advance, so sharing answers is useless.
- **Nothing money-related.** Tasks are puzzles, spotting, reflexes, and social posts.
- **Binary result.** Only pass or fail feeds streaks, salary, and layoffs.

### 4.2 MVP tasks (build these)

**Decode the Memo.** A corporate memo is hidden in a cipher. The employee decodes it and submits the secret word. The boss writes the memo text. Code generates the cipher and the expected answer from the day secret and the wallet address.

**Fire Drill.** An alarm sounds and the employee taps the exits in the right order under a time limit. The server records the sequence and time. Code checks the sequence and the limit.

The MVP posts one of these two every day through the automatic scheduler in 4.4, so the demo shows both a puzzle and a reflex task.

### 4.3 Roadmap tasks (show as slides, do not build)

| Task | What you do | Verification |
| --- | --- | --- |
| Spot the Fake | Pick the AI-generated image of three | Answer committed before task opens |
| Liar's Lunch | Pick the false company fact of three | Ground truth committed in advance |
| Casual Friday | Post a caption with the day's code word | Bot checks for the code word; best caption earns a cosmetic badge by crowd vote |
| Weekend Overtime | Each employee reveals one piece of a giant puzzle | Contract counts pieces; completing it gives everyone a shared badge |

### 4.4 Daily automatic tasks

The boss posts a new task every day with no human involved. A scheduler on the boss service runs the same cycle every epoch: 24 hours in production, 3 to 5 minutes in demo mode.

1. **Pick.** The scheduler chooses today's task type from the library. It never repeats yesterday's type, and it follows a weekly rhythm once more types exist.
2. **Generate.** Code builds the task from a template with fresh parameters. The LLM writes only the flavor text.
3. **Check.** A script solves the generated puzzle itself and confirms it has exactly one valid answer. If the LLM text fails the format check or the puzzle fails the solve check, the scheduler falls back to a pre-written template for that day.
4. **Commit and open.** The boss draws a new `day_secret` and calls `open_task` with its hash. The announcement lands in the feed and the tower alarm goes off.
5. **Close.** The submission window ends at `closes_at`.
6. **Finalize.** The boss reveals the secret and calls `finalize_task` with the pass list. Salaries become claimable and the day's announcements post.

**What changes every day.** Decode the Memo varies the cipher type, the memo topic, and the message length. Fire Drill varies the number of exits, the length of the sequence, and the time limit. Roadmap tasks plug into the same cycle with their own generators. Every wallet also gets its own seed (section 4.1), so no two employees see the same puzzle on the same day.

**Difficulty adjusts itself.** Each task type has difficulty steps from 1 to 5, for example cipher type and message length. After each finalized day, if more than 90% of employees passed, the next task of that type goes one step harder. If fewer than 50% passed, it goes one step easier. This keeps the pass rate in a range where missing a day still means something. Both thresholds are tunable.

**If the boss fails.** The scheduler retries. If a task is still not finalized 6 hours after it closes, anyone can void it. A voided task changes nobody's streak, triggers no layoffs, and carries its income over, so employees are never punished for an outage. Streaks and layoff counters count task numbers, not calendar days, so a day with no task changes nothing.

## 5. Economy

### 5.1 Income

The treasury only receives money from outside. Nothing is printed.

- **Trading-fee share:** a small slice of token trades routed to the treasury. For the hackathon this can be a configured fee-split address.
- **Client jobs:** outsiders attach NEAR to post a task such as "name my product" or "roast my landing page." The company keeps a cut. For the MVP, treat these as treasury deposits.

### 5.2 Daily split of accrued income

| Bucket | Share | Use |
| --- | --- | --- |
| Payroll | 60% | Paid to employees who passed today's task |
| Reserve | 30% | Company runway |
| Jackpot | 10% | First correct submission (Employee of the Day) |

### 5.3 Payroll formula

The payroll pool is split across the four tier buckets (section 3). Inside a tier:

`your pay = tier bucket x your weight / sum of weights of everyone in the tier who submitted`

`weight = balance at submission x streak multiplier`

`streak multiplier = 1 + 0.10 x consecutive days passed, capped at 1.50`

- Pay is proportional to balance within a tier, so splitting holdings across wallets earns the same total.
- The shares of employees who failed or skipped are not redistributed to other workers. They go to the reserve. Missing a day costs you money and extends the company's runway.
- The denominator counts every submitter in the tier, pass or fail (reapplications excluded), fixed at submission time. Employees who never submitted do not dilute it. So each passer's pay does not depend on who else passed, and a tier with a single submitter takes its whole bucket if they pass (amended: ROADMAP D1, `docs/PROTOCOL.md` §7.3).

**Worked example.** Income is 20 NEAR. Payroll is 12 NEAR and the Intern bucket is 15%, so 1.8 NEAR. Three interns hold 100k, 50k, and 50k tokens, all at streak zero. If all pass, they receive 0.9, 0.45, and 0.45 NEAR. If the second intern submits a wrong answer, they receive nothing, and 0.45 NEAR moves to the reserve. If the second intern does not submit at all, the other two split the bucket by weight: 1.2 and 0.6 NEAR.

### 5.4 Anti-dump rule

Because weight is snapshotted at submission, someone could submit and then sell. To prevent this, a salary claim requires the claimant's current balance to be at least 90% of the snapshotted balance. Otherwise the share is forfeited to the reserve.

**Anti-recycling (added: ROADMAP D15).** The 90% check does not stop one bag from being counted twice: wallet A submits, sends its tokens to B, B submits, and the tokens go back to A before claims. So the token records when each account last received tokens, and a submission is rejected if the wallet received any at or after the task opened. Someone who buys during a task's window starts with the next task.

### 5.5 Layoffs

- Miss 3 consecutive tasks and you are laid off for 7 days with no salary eligibility.
- Layoffs are announced publicly and issue a Laid Off badge.
- You can return early by passing a reapplication task.
- Layoff status is computed lazily from `last_pass_day`, so the contract never loops over employees.

### 5.6 Operating costs and bankruptcy

- Each day, a fixed operating cost is paid from the reserve to the boss operator address to cover LLM and server costs. It is public in the ledger.
- If the reserve is empty for 3 consecutive daily finalizations, the company is declared **bankrupt**.
- On bankruptcy, remaining funds become severance, claimable by employees who passed the last task, weighted by that task's snapshot weights. The company then closes. It ends with a payout, not a rug.

## 6. System architecture

Four components:

1. **NEAR contract** (Rust). Source of truth for employees, tasks, results, salaries, and treasury.
2. **Fungible token** (NEP-141). The memecoin. The contract reads balances and total supply through cross-contract calls.
3. **Boss service** (server). Holds the boss key and the daily secret. Runs the daily schedule on its own: generates each task, serves personalized puzzles, records submissions, runs the LLM for flavor text, and calls the contract's boss-only functions to open and finalize each day.
4. **Tower game client (web app). Wallet connect, the tower view, the desk and task screens**, live feeds.

```
Employee wallet -> Dashboard -> Boss service (get puzzle)
Employee wallet -> Contract.submit (answer hash)
Boss service -> Contract.finalize_task (reveal secret, pass list)
Contract -> FT contract (ft_balance_of, ft_total_supply)
Contract -> Employees (salary claims)
```

### Trust model (state this plainly in the pitch)

During the day, the boss service is trusted: it knows the secret and serves puzzles. After the day closes it reveals the secret, and the contract checks it against the commitment made at the start. Anyone can verify afterward that results were computed honestly. The Fire Drill is the most trusted task, since timing is recorded by the server. Treat it as server-verified, and say so.

## 7. Contract design

### 7.1 State

- `config`: token contract, boss account, epoch length, tier thresholds, bucket shares, split percentages, operating cost, layoff rules, streak cap.
- `employees: Map<AccountId, Employee>`
  - `streak: u32`
  - `last_pass_day: u64`
  - `laid_off_until: u64`
  - `badges: u64` (bitmask)
  - `total_earned: U128`
- `tasks: Map<u64, Task>`
  - `id`, `kind`, `commit_hash` (sha256 of the day secret), `opens_at`, `closes_at`
  - `status`: Open, Closed, Finalized
  - `submissions: Map<AccountId, Submission>` holding answer hash, snapshotted balance, tier, and time
  - `passers` and per-tier weight sums
  - `income_allocated`, `employee_of_the_day`
- `treasury`: `reserve`, `income_accrued`, `empty_days`
- `company_status`: Active or Bankrupt.

### 7.2 Methods

| Method | Caller | Purpose |
| --- | --- | --- |
| `new(config)` | deployer | Initialize and cache total supply |
| `open_task(kind, commit_hash, closes_at)` | boss | Open a day's task with the secret commitment |
| `submit(task_id, answer_hash)` | employee | Records the submission, then makes a cross-contract call to read balance and compute tier |
| `on_balance(...)` | callback | Stores snapshotted balance and tier; rejects holders below the minimum |
| `finalize_task(task_id, day_secret, passers)` | boss | Verifies the secret against the commitment, verifies each passer's answer, updates streaks, allocates income across payroll, reserve, and jackpot |
| `claim_salary(task_id)` | employee | Pays the employee's share if the anti-dump rule holds |
| `deposit_income()` | anyone | Adds NEAR to the treasury (client jobs and fee share) |
| `declare_bankruptcy()` | anyone | Callable after the empty-reserve condition is met |
| `claim_severance()` | employee | Pays severance after bankruptcy |
| `view_*` | anyone | Employee status, task, treasury, leaderboard |

For the automatic daily cycle the contract also exposes `void_task(task_id)`, callable by anyone once a task is 6 hours past its close time without being finalized. It cancels that task and leaves streaks, layoffs, and income untouched. In the contract state, "day" fields such as `last_pass_day` hold the task number, not the calendar date.

### 7.3 Events (for the live feed)

`task_opened`, `task_finalized`, `salary_paid`, `employee_of_the_day`, `streak_milestone`, `laid_off`, `rehired`, `reserve_low`, `bankrupt`.

### 7.4 Verification flow

1. Boss generates a random `day_secret` and calls `open_task` with `sha256(day_secret)`.
2. Dashboard asks the boss service for the wallet's puzzle after a signed login. The puzzle and expected answer are derived from `HMAC(day_secret, wallet)`.
3. Employee solves it and calls `submit` with `hash(answer + wallet)`.
4. After the window closes, the boss calls `finalize_task` with `day_secret` and a pass list.
5. The contract checks the commitment, then verifies each listed passer by recomputing the expected answer hash. The pass list is capped per call, and large lists can be batched.
6. Streaks, income allocation, and jackpot are applied. Salaries become claimable.

## 8. The AI boss

### 8.1 What the LLM does

- Writes the daily flavor text: the memo, the alarm scenario, the announcements.
- Delivers layoff notices, promotions, and streak reactions in a consistent voice.
- Writes the post-mortem if the company goes bankrupt.

### 8.2 What the LLM never does

- It never decides pass or fail.
- It never chooses who is paid or fired.
- It never holds funds. Only the boss key can call boss-only functions, and those functions enforce the rules in code.

### 8.3 Personality

A passive-aggressive corporate executive who is relentlessly upbeat about terrible news. Uses buzzwords, calls layoffs "a rebalancing of talent," and thanks fired employees for their service. All humor lives in text. The contract only sees pass or fail.

### 8.4 Prompt inputs

Today's task type and seed, company stats (headcount, reserve, runway), yesterday's results, and a list of events to announce. Output is structured JSON with `task_text`, `announcements`, and `tone_notes`, validated before use.

## 9. The app: a living company tower

The app is a game, not a dashboard: a flat side-on cutaway of an office tower where every holder is a small employee at a desk, and the tower grows as holders join. Everything on screen is drawn from real onchain state and events.

### 9.1 The tower

A 2D cross-section, like a building cut in half, with a camera that pans up and down and zooms in and out. From top to bottom:

- **Penthouse:** the AI boss's office. A big screen shows today's task, and the boss reacts to results with a face.
- **Director floors:** private offices with a window view, 4 per floor.
- **Manager floors:** glass offices, 6 per floor.
- **Associate floors:** cubicles, 10 per floor.
- **Intern floors:** shared open-plan desks, 16 per floor.
- **Lobby:** reception and the HR exit door. Laid-off employees leave here with a box. Visitors holding below the minimum stand outside the glass doors, looking in.
- **Basement:** the treasury vault with a visible pile of NEAR that shrinks with operating costs and grows with income, plus the server room where the boss runs.

Each floor belongs to one tier, and the layout is computed from the employee list (sorted by tier, then balance), so every player sees the same tower.

&#91;embedded content: tower cutaway · 4 tier floors, lobby, basement\]

Directors sit highest and Interns lowest among the office floors, with the vault and server room below ground.

### 9.2 Holders as characters

- **One wallet, one character.** Look, hair, shirt, and desk item come from the wallet hash, so each holder gets a stable, unique look without custom art.
- **Idle:** typing at the desk. **Submitted:** a "done" bubble over the monitor. **Passed:** a coin pops above the desk.
- **Streaks:** a small flame aura at 3, 7, and 14 days. A missed day puts out the flame.
- **Struggling:** a sweat drop after 1 or 2 misses in a row.
- **Laid off:** the character packs a box, walks to the lobby door, and the desk shows an "On leave" sign.
- **Employee of the Day:** a spotlight and a golden hard hat until the next task opens.
- **Your character** pulses so you can find it instantly. Click anyone to see wallet, title, share of supply, streak, badges, and last 7 results.

### 9.3 Growth with holders

The tower scales with the number of employees. At the default thresholds the company cannot exceed 100,000 employees (100% of supply divided by 0.001%), and Directors cannot exceed 33. Thresholds are in parts per million, so the ceiling can go to 1,000,000. Visitors below the minimum are not counted and appear as a crowd in the lobby. Past 40 floors per tier the headquarters folds the remaining floors into one band with their exact counts; those floors work in annex towers beside it (design spec §4.3, §12).

| Stage | Employees | What the player sees |
| --- | --- | --- |
| Garage startup | 1 to 10 | One floor per tier, large detailed characters |
| Small office | 11 to 50 | A few floors per tier; a construction crane adds a floor when a tier's desks fill |
| Office tower | 51 to 250 | A tall tower, the camera follows your character, elevators visible |
| Skyscraper | 251 to 1,000 | Distant floors drawn as color strips showing the day's pass rate; only visible floors render in detail |
| Megacorp | 1,001 to 5,000 | A second tower rises beside it for the folded floors |
| Campus | 5,001 to 25,000 | A row of annex towers |
| Conglomerate | 25,001 and up | A skyline of annex towers |

Floors are added when a tier's desks are full and removed when they empty. The tower has no memory: its floors and stage are a pure function of the current holders, so every client, fresh or long-running, draws the same building (amended: ROADMAP D20). Every tier always keeps at least one floor.

### 9.4 Company life: events become visuals

Every animation that means something is tied to a contract event or state. Idle typing and background movement are cosmetic only.

| Onchain event | What you see |
| --- | --- |
| `task_opened` | Alarm light spins, the boss screen shows the task, characters turn to their monitors |
| Submission received | The character's monitor flashes and a "submitted" bubble appears |
| `task_finalized` (pass) | Green check and a coin over the desk |
| `task_finalized` (miss) | Red flicker and a paper jam on the desk |
| `salary_paid` | Coins run down pipes from the vault to each desk, tier by tier |
| `employee_of_the_day` | Spotlight and a golden hard hat |
| `streak_milestone` | Flame aura appears |
| Tier change (seen at next submission) | The character rides the elevator to its new floor |
| `laid_off` | The boss announces it on the penthouse screen; the character packs a box and leaves through the lobby |
| `rehired` | The character walks back in and sits down |
| `reserve_low` | The vault lights flash red and the upper floors dim |
| `bankrupt` | Lights go out floor by floor, the vault is empty, a "Closed" sign hangs on the door |

On Fire Drill days the alarm is literal: characters run for the stairwells while the employee plays the reflex game on their own monitor.

### 9.5 Screens and controls

- **Tower view (main).** A top bar shows headcount by tier, reserve and runway, and today's task countdown. Drag to pan, scroll to zoom.
- **My desk.** Click your character or press Go to my desk. Your monitor opens today's puzzle or the Fire Drill as a pop-up. Claim Salary appears as coins at your desk.
- **Penthouse.** The boss feed: announcements, layoff notices, and flavor text.
- **Vault.** Click the basement to open the ledger of income, salaries, and operating costs, each linked to its transaction.

### 9.6 How it is built

- A 2D renderer in a web app (for example PixiJS or Phaser) with a flat vector or pixel-art style.
- One base character sprite with palette, hair, and accessory variants chosen from the wallet hash.
- The renderer only reads state: contract view methods plus the event feed. It never holds game logic.
- Only visible floors are drawn. Far floors collapse into color strips.
- **Demo mode:** a seeded crowd of simulated employees, clearly labeled simulated, and a button that jumps between growth stages so the tower can grow on stage.
- **Hackathon scope:** build the first three stages and these animations: sit and work, pass and
- &#32;miss, payday coins, and the layoff walk-out. Cut the skyline stage, day and night, and bankruptcy blackout unless time remains.

## 10. Demo mode

- Epoch length is a config value. In production it is 24 hours. In the demo it is 3 to 5 minutes so a full cycle fits on stage.
- Pre-seed five wallets across all four tiers, plus one near the layoff line.
- Use testnet NEAR and a small test token supply.

### Three-minute demo script

1. Show the tower: five wallets auto-listed as characters on their tier's floor, the vault in the basement, and the runway.
2. The boss posts the day's Decode the Memo. Two wallets solve it live.
3. Finalize: salaries appear, the jackpot goes to the fastest solver, and the transaction is shown.
4. One wallet has missed its third task. Show the layoff notice in the feed.
5. That wallet passes a reapplication task and is rehired.
6. Close on the ledger: income in, salaries out, runway remaining.

## 11. Build plan

### Must build

- Contract with employees, tasks, commit-reveal finalize, salary claims, lazy streaks and layoffs, and the treasury split.
- Boss service with the automatic daily scheduler, the Decode the Memo and Fire Drill generators, and the LLM flavor text.
- Tower game client with the tower view, My Desk, task screens, and event feed.
- Demo mode with a short epoch.

### Build if time allows

- Bankruptcy and severance.
- Employee of the Day jackpot polish and badges.
- Tower polish (elevator promotions, bankruptcy blackout) and the ledger page.

### Cut

- Additional task types (show as roadmap).
- Manager policy votes and Director impeachment.
- Trading-fee routing beyond a configured address.
- Reproduction, launchpad, and custom token mechanics.

## 12. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Server is trusted for puzzles and timing | Secret commitment and reveal make results auditable afterward; say so in the pitch |
| People solve puzzles with AI tools | Allow it openly ("employees may use any tools"); personalized seeds prevent copying |
| Hold, submit, then sell | 90% balance check at claim time; otherwise the share goes to the reserve |
| Too easy, so layoffs never happen | Tune difficulty; demo mode forces a near-layoff wallet |
| Treasury has no real income during the demo | Seed with testnet deposits and show the fee-split and client-job paths as the model |
| Cross-contract balance reads add latency | Cache tier on submission and accept that eligibility updates per task, not instantly |

## 13. Parameters to tune

| Parameter | Default |
| --- | --- |
| Tier thresholds | 3% / 1% / 0.25% / 0.001% |
| Tier bucket shares | 35 / 30 / 20 / 15 |
| Income split | 60 payroll / 30 reserve / 10 jackpot |
| Streak bonus | +10% per day, cap +50% |
| Layoff trigger | 3 consecutive misses |
| Layoff length | 7 days |
| Bankruptcy trigger | Reserve empty for 3 days |
| Anti-dump threshold | Balance at least 90% of snapshot |
| Epoch length | 24 h (demo: 3 to 5 min) |

## 14. Open questions

- How long is the hackathon, and does it require a token already deployed or one launched during it?
- Does the judging emphasize technical depth, user growth, or presentation? This decides how much effort goes into the contract versus the tower game.
- Should the pitch lead with the economy (real salaries from real income) or with the culture (an AI boss with a personality)?

## 15. Hackathon fit and 6-day plan

REORG enters NEAR HACKATHON, whose development phase ends on 2026-11-14 at 23:59 UTC (06:59 on 15 November in Hanoi). This section follows the organizers' HACKATHON.md. The live version is at https://nearhackathon.com/HACKATHON.md and must be re-read before submitting, because dates and rules can change.

### 15.1 Tracks to enter

A submission can list every track the project truly fits.

| Track | Why REORG fits | What the rules say judges weigh |
| --- | --- | --- |
| Memecoins With Mechanics (`memecoins`) | The token is a job: supply share sets title and payroll bucket | Judged on the mechanic, not the chart |
| Games With Real Economies (`games`) | The tower is the game, and the loop is task, pay, layoff | Judged on the game loop, not the token; bonus if players never notice the chain |
| Autonomous Business (`business`) | An AI boss runs a treasury and pays holders; humans only set parameters | AI-native business with treasury and revenue sharing |
| Agent Economy (`agents`), optional | The boss earns from income and pays out | Agents that earn and spend |

List `memecoins`, `games`, and `business` first. Add `agents` only if client jobs ship. In the demo, income is partly seeded, so the README must say plainly which income paths are real and which are simulated.

### 15.2 NEAR's role (for the README and the demo post)

- **NEP-141 token:** holding it is employment, and share of supply sets the title.
- **NEAR contract:** holds the treasury and pays salaries in NEAR from onchain pass or fail results.
- **Commit and reveal:** each day's secret is committed onchain and revealed after the window, so anyone can audit the boss.
- **Optional:** NEAR AI Cloud for the boss's flavor-text LLM, using the credits the rules describe. Check the NEAR docs before integrating.
- Testnet projects are eligible in every track, and testnet NEAR is free.

### 15.3 Scope for the window

This scope overrides the "Must build" list in section 11 for the hackathon.

**Build:**

- NEP-141 token and one contract: tiers from supply share, `open_task`, `submit`, `finalize_task`, `claim_salary`, streaks, and lazy layoffs.
- Boss service with the daily scheduler and one task type (Decode the Memo), plus LLM flavor text.
- Tower game with growth stages 1 and 2, characters drawn from onchain state, and the pass, miss, payday, and layoff animations.
- Demo mode with a short epoch and a labeled seeded crowd.

**Move to stretch:** Fire Drill, self-adjusting difficulty, `void_task`, bankruptcy and severance, the Employee of the Day jackpot, growth stages 3 to 5, and trading-fee routing.

| Date (UTC) | Goal |
| --- | --- |
| 8 to 9 Nov | Token and contract skeleton with tests |
| 10 Nov | Boss service: scheduler, Decode the Memo generator, commit and reveal, flavor text |
| 11 Nov | Tower view and character animations driven by contract state |
| 12 Nov | Layoffs, demo mode, and a full end-to-end run on testnet |
| 13 Nov | README, LICENSE, run script, demo video, public repo |
| 14 Nov | Post on X and submit before midday UTC, leaving a buffer for fixes |

### 15.4 Submission checklist

- [ ] Repository is public before 2026-11-14 23:59 UTC and has a LICENSE file.
- [ ] README works for a screening agent and a human: what it is, the problem, "do X, see Y" steps to try it, NEAR's role, libraries and AI-generated code listed, and income paths marked real or simulated.
- [ ] Demo is reproducible locally with one command, and hosted too if possible. Keep it up through 2026-11-18, ideally 2026-11-25.
- [ ] Demo video shows one complete moment: the boss posts a task, an employee solves it, salary is paid, a layoff lands.
- [ ] X post says the project was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, and attaches the video. @NearLegion and @NearBuilders are optional.
- [ ] The team lead confirms the exact submission payload: project name, lead name, email, team size, tracks, mainnet NEAR payout account, repo link, demo post link, description (20 to 2,000 characters), and consent.
- [ ] Submit once, through the form at https://nearhackathon.com/#apply or the API. Mistakes are fixed at https://nearhackathon.com/request-changes, never by submitting again.

Only the team can make the repository public, publish the post, create the payout account, and confirm the submission.

### 15.5 Demo post draft

About 270 characters. The two bracketed links are for the team to fill in.

```text
Your token is your job. In REORG, holding the token hires you at an AI-run company. Pass the daily task, get paid in NEAR. Miss three, get laid off. Built at NEAR HACKATHON with @NEARProtocol #NEARHackathon. Demo + repo: [link]. What should the boss assign tomorrow?
```
