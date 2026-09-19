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

test("a repeated identical marker is accepted", () => {
  const r = extractVerdict("VERDICT: PASS\n(restated)\nVERDICT: PASS");
  assert.equal(r.verdict, "PASS");
  assert.equal(r.occurrences.pass, 2);
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
