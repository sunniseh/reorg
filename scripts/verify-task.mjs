#!/usr/bin/env node
// Audit one finalized REORG task from public chain data only (docs/PROTOCOL.md §3–§5).
// No dependencies and no repo code: Node's crypto and fetch against a NEAR RPC.
//
//   node scripts/verify-task.mjs <contract_id> <task_id> [rpc_url]
//   node scripts/verify-task.mjs reorg.reorg-root.testnet 3
//
// Checks that sha256(day_secret) equals the commitment published when the task opened, then
// re-derives every submitter's code from the revealed secret and compares the expected answer
// hash with what they submitted and with the pass/fail the contract recorded.
import { createHash, createHmac } from "node:crypto";

const [contractId, taskArg, rpcArg] = process.argv.slice(2);
if (!contractId || !taskArg) {
  console.error("usage: node scripts/verify-task.mjs <contract_id> <task_id> [rpc_url]");
  process.exit(2);
}
const taskId = Number(taskArg);
const rpc = rpcArg ?? (contractId.endsWith(".testnet") ? "https://test.rpc.fastnear.com" : null);
if (!rpc) {
  console.error("pass the rpc url (npm run demo prints it as `rpc http://127.0.0.1:<port>`)");
  process.exit(2);
}

async function view(method, args) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    }),
  });
  const j = await res.json();
  const err = j.error ?? j.result?.error;
  if (err) throw new Error(`${method}: ${typeof err === "string" ? err : JSON.stringify(err)}`);
  return JSON.parse(Buffer.from(j.result.result).toString());
}

const sha256 = (b) => createHash("sha256").update(b).digest();

/** PROTOCOL.md §4: the 8-letter code for a wallet, from HMAC-SHA256(day_secret, wallet). */
function code(secret, wallet) {
  const h = createHmac("sha256", secret).update(wallet, "utf8").digest();
  let s = "";
  for (let i = 0; i < 4; i++) s += "BDFGKLMNPRSTVZ"[h[2 * i] % 14] + "AEIOU"[h[2 * i + 1] % 5];
  return s;
}

/** PROTOCOL.md §5: sha256(norm(answer) ‖ 0x00 ‖ wallet); a derived code is already normalized. */
const answerHash = (c, wallet) => sha256(Buffer.concat([Buffer.from(c, "utf8"), Buffer.from([0]), Buffer.from(wallet, "utf8")])).toString("base64");

const task = await view("get_task", { task_id: taskId });
if (!task) throw new Error(`task ${taskId} not found on ${contractId}`);
console.log(`task ${taskId} on ${contractId}: ${task.status}, ${task.submitted} submitted, ${task.passed} passed`);
if (!task.day_secret) {
  console.log("the secret is not revealed yet (it is revealed at finalize); try a finalized task");
  process.exit(1);
}

const secret = Buffer.from(task.day_secret, "base64");
const commitOk = secret.length === 32 && sha256(secret).toString("base64") === task.commit_hash;
console.log(`commitment: sha256(day_secret) ${commitOk ? "==" : "!="} commit_hash published at open  ${commitOk ? "OK" : "MISMATCH"}`);

const subs = [];
for (let from = 0; ; from += 50) {
  const page = await view("list_submissions", { task_id: taskId, from_index: from, limit: 50 });
  subs.push(...page);
  if (page.length < 50) break;
}

let bad = 0;
let censored = 0;
for (const s of subs) {
  const correct = answerHash(code(secret, s.account_id), s.account_id) === s.answer_hash;
  const note = correct === s.passed ? "" : correct ? "  <- correct but not on the pass list (prove_pass can recover it)" : "  <- MARKED PASSED WITH A WRONG ANSWER";
  if (!correct && s.passed) bad++;
  if (correct && !s.passed && task.status === "finalized") censored++;
  console.log(`  ${s.account_id.padEnd(32)} answer ${correct ? "correct" : "wrong  "}  recorded ${s.passed ? "pass" : "fail"}${s.reapply ? " (reapply)" : ""}${note}`);
}

const ok = commitOk && bad === 0;
console.log(`${subs.length} submissions re-checked: ${bad} passed with a wrong answer, ${censored} correct answers left off the pass list`);
console.log(ok ? "VERIFIED: the boss committed before the task and every recorded pass is a correct answer." : "NOT VERIFIED (see above)");
process.exit(ok ? 0 : 1);
