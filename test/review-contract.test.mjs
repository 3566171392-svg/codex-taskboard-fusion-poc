import assert from "node:assert/strict";
import test from "node:test";
import {
  VERDICT_MARKER,
  buildReviewInstruction,
  extractFindings,
  extractVerdict,
} from "../src/core/review-contract.mjs";

test("extracts an explicit PASS marker", () => {
  const r = extractVerdict("Reviewed the workspace.\nNo defects found.\n\nVERDICT: PASS");
  assert.equal(r.verdict, "PASS");
  assert.equal(r.marker, VERDICT_MARKER.PASS);
  assert.equal(r.occurrences.pass, 1);
});

test("extracts an explicit FAIL marker", () => {
  const r = extractVerdict("The guard is missing.\nVERDICT: FAIL");
  assert.equal(r.verdict, "FAIL");
  assert.equal(r.marker, VERDICT_MARKER.FAIL);
});

test("tolerates surrounding markdown decoration on the marker line", () => {
  assert.equal(extractVerdict("**VERDICT: PASS**").verdict, "PASS");
  assert.equal(extractVerdict("`VERDICT: FAIL`").verdict, "FAIL");
  assert.equal(extractVerdict("   VERDICT: PASS   ").verdict, "PASS");
});

test("never infers a verdict from prose", () => {
  assert.equal(extractVerdict("Everything looks good to me.").verdict, null);
  assert.equal(extractVerdict("I think this is correct and ready to ship.").verdict, null);
  assert.equal(extractVerdict("").verdict, null);
  assert.equal(extractVerdict("VERDICT: MAYBE").verdict, null);
  assert.equal(extractVerdict("The verdict is that the patch is correct").verdict, null);
});

test("an ambiguous review is not a verdict", () => {
  const r = extractVerdict("VERDICT: PASS\n...\nVERDICT: FAIL");
  assert.equal(r.verdict, null);
  assert.match(r.reason, /both/i);
});

/**
 * The contract is fail-closed. A repeated marker is ambiguous: nothing in the
 * output says which one governs, so position must not decide it. An earlier
 * revision let the last occurrence win, which turned contradictory or restated
 * output into a confident PASS.
 */
test("a repeated identical marker is BLOCKED, not last-one-wins", () => {
  const pass = extractVerdict("VERDICT: PASS\n(restated)\nVERDICT: PASS");
  assert.equal(pass.verdict, null, "duplicate PASS must not produce a verdict");
  assert.match(pass.reason, /2 times|ambiguous/i);
  assert.equal(pass.occurrences.pass, 2);

  const fail = extractVerdict("VERDICT: FAIL\nVERDICT: FAIL");
  assert.equal(fail.verdict, null, "duplicate FAIL must not produce a verdict");
  assert.match(fail.reason, /2 times|ambiguous/i);
  assert.equal(fail.occurrences.fail, 2);
});

test("the full verdict matrix is fail-closed", () => {
  const cases = [
    ["no marker", "I looked around and nothing seemed wrong.", null],
    ["one PASS", "Clean.\nVERDICT: PASS", "PASS"],
    ["one FAIL", "Broken.\nVERDICT: FAIL", "FAIL"],
    ["PASS then FAIL", "VERDICT: PASS\nVERDICT: FAIL", null],
    ["FAIL then PASS", "VERDICT: FAIL\nVERDICT: PASS", null],
    ["two PASS", "VERDICT: PASS\nVERDICT: PASS", null],
    ["two FAIL", "VERDICT: FAIL\nVERDICT: FAIL", null],
    ["PASS plus two FAIL", "VERDICT: PASS\nVERDICT: FAIL\nVERDICT: FAIL", null],
    ["three PASS", "VERDICT: PASS\nVERDICT: PASS\nVERDICT: PASS", null],
    ["empty", "", null],
  ];
  for (const [label, text, expected] of cases) {
    const r = extractVerdict(text);
    assert.equal(r.verdict, expected, `${label}: expected ${expected}, got ${r.verdict} (${r.reason})`);
    if (expected === null && text.trim() !== "") {
      assert.ok(r.reason, `${label}: a blocked verdict must carry a reason`);
    }
  }
});

test("decoration does not create a second marker", () => {
  // A single decorated marker is still exactly one marker.
  assert.equal(extractVerdict("**VERDICT: PASS**").verdict, "PASS");
  // Quoting the marker inside prose is still a second marker line, so it blocks.
  assert.equal(extractVerdict("VERDICT: PASS\n> VERDICT: PASS").verdict, null);
});

test("findings keep the review body but drop the marker line", () => {
  const body = "Line one.\nsrc/math.js: the guard is missing.\n\nVERDICT: FAIL";
  const findings = extractFindings(body);
  assert.match(findings, /guard is missing/);
  assert.doesNotMatch(findings, /VERDICT:/);
});

test("the reviewer instruction carries the contract, not the executor transcript", () => {
  const instruction = buildReviewInstruction({
    task: { id: "T1", title: "Fix the guard" },
    acceptanceCriteria: ["divide(10,0) must throw"],
    evidence: { allChecksPassed: true, checks: [{ command: "node --test", passed: true }] },
    workspacePath: "D:/ws",
    reviewScope: ["src/math.js"],
  });
  assert.match(instruction, /VERDICT: PASS/);
  assert.match(instruction, /VERDICT: FAIL/);
  assert.match(instruction, /D:\/ws/);
  assert.match(instruction, /divide\(10,0\) must throw/);
  assert.match(instruction, /src\/math\.js/);
  assert.match(instruction, /node --test/);
  assert.match(instruction, /do not trust/i);
});
