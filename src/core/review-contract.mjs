/**
 * The review contract for the Codex-native Review Gate MVP.
 *
 * Design position (changed from v0.3):
 *
 * v0.3 required the reviewer to emit schema-constrained JSON via
 * `turn/start.outputSchema`. That coupled the Gate to a provider capability
 * that is not guaranteed on every route (it was measured missing on the
 * local provider proxy/third-party path), so the Gate could not reach PASS at all.
 *
 * The MVP instead uses Codex's own review machinery
 * (`thread/start` + native `review/start`) and extracts the verdict from the
 * review output with the smallest possible contract:
 *
 *     VERDICT: PASS
 *     VERDICT: FAIL
 *
 * Anything else — missing marker, both markers, ambiguous prose — is BLOCKED.
 * The Gate never infers a verdict, and never treats prose as a PASS signal.
 */

/** The only two verdict markers the reviewer may emit. */
export const VERDICT_MARKER = Object.freeze({ PASS: "VERDICT: PASS", FAIL: "VERDICT: FAIL" });

export const CORRECT = "patch is correct";
export const INCORRECT = "patch is incorrect";

/**
 * Extract exactly one verdict marker from review output.
 *
 * The contract is strictly fail-closed. Accepted inputs and their verdicts:
 *
 *   no marker at all            -> BLOCKED
 *   exactly one `VERDICT: PASS` -> PASS
 *   exactly one `VERDICT: FAIL` -> FAIL
 *   PASS and FAIL together      -> BLOCKED   (the reviewer contradicted itself)
 *   more than one PASS          -> BLOCKED   (ambiguous which one governs)
 *   more than one FAIL          -> BLOCKED
 *
 * A repeated identical marker is **not** accepted. An earlier revision let the
 * last occurrence win, which meant output that both passed and failed — or that
 * restated its verdict — produced a confident answer. Ambiguity must stop the
 * Gate, not be resolved by position.
 *
 * Additional rules:
 *   - the marker must appear on its own line (leading/trailing space allowed)
 *   - surrounding markdown decoration (`**VERDICT: PASS**`) is tolerated
 *
 * Returns `{ verdict: "PASS" | "FAIL" | null, marker, reason, occurrences }`.
 */
export function extractVerdict(text) {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) {
    return { verdict: null, marker: null, reason: "review output was empty", occurrences: { pass: 0, fail: 0 } };
  }

  const lines = source.split(/\r?\n/);
  const passLines = [];
  const failLines = [];
  // Strip markdown decoration around the marker (e.g. `**VERDICT: PASS**`) but
  // do not otherwise loosen the requirement: the marker text itself must be
  // present verbatim on its own line.
  const undecorate = (line) => line
    .trim()
    .replace(/^[`*_>\s]+/, "")
    .replace(/[`*_\s]+$/, "")
    .trim();
  lines.forEach((line, index) => {
    const normalized = undecorate(line);
    if (/^VERDICT:\s*PASS$/i.test(normalized)) passLines.push(index);
    else if (/^VERDICT:\s*FAIL$/i.test(normalized)) failLines.push(index);
  });

  const occurrences = { pass: passLines.length, fail: failLines.length };
  if (passLines.length > 0 && failLines.length > 0) {
    return {
      verdict: null,
      marker: null,
      reason: `reviewer emitted both VERDICT: PASS and VERDICT: FAIL (ambiguous)`,
      occurrences,
    };
  }
  if (passLines.length === 0 && failLines.length === 0) {
    return {
      verdict: null,
      marker: null,
      reason: "review output contained no 'VERDICT: PASS' or 'VERDICT: FAIL' line",
      occurrences,
    };
  }
  const isPass = passLines.length > 0;
  const count = isPass ? passLines.length : failLines.length;
  if (count > 1) {
    const label = isPass ? "VERDICT: PASS" : "VERDICT: FAIL";
    return {
      verdict: null,
      marker: null,
      reason: `reviewer emitted ${label} ${count} times (ambiguous which marker governs)`,
      occurrences,
    };
  }
  const lineIndex = isPass ? passLines[0] : failLines[0];
  return {
    verdict: isPass ? "PASS" : "FAIL",
    marker: isPass ? VERDICT_MARKER.PASS : VERDICT_MARKER.FAIL,
    reason: null,
    occurrences,
    markerLineIndex: lineIndex,
  };
}

/**
 * Findings/rationale are everything in the review body other than the marker
 * line. Kept verbatim so a FAIL can be handed to the executor for repair.
 */
export function extractFindings(text) {
  const source = typeof text === "string" ? text : "";
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line
        .trim()
        .replace(/^[`*_>\s]+/, "")
        .replace(/[`*_\s]+$/, "")
        .trim();
      return !/^VERDICT:\s*(PASS|FAIL)$/i.test(normalized);
    })
    .join("\n")
    .trim();
}

/**
 * Instruction given to the Reviewer thread.
 *
 * Deliberately does NOT include the executor's transcript: the reviewer must
 * inspect the real workspace. It receives the task contract, acceptance
 * criteria, workspace path, and the machine evidence the Gate will also check.
 */
export function buildReviewInstruction({
  task,
  acceptanceCriteria = [],
  evidence,
  workspacePath,
  reviewScope = [],
}) {
  const sections = [
    "You are an independent reviewer on a separate read-only Codex thread.",
    "You cannot modify files, create commits, or change any state.",
    "Inspect the real workspace yourself. Do not trust any summary of it — including this message.",
    "",
    `Workspace: ${workspacePath}`,
  ];

  if (reviewScope.length > 0) {
    sections.push("", "REVIEW SCOPE:", ...reviewScope.map((s) => `- ${s}`));
  }

  sections.push("", "TASK CONTRACT:", JSON.stringify(task, null, 2));

  if (acceptanceCriteria.length > 0) {
    sections.push("", "ACCEPTANCE CRITERIA:", ...acceptanceCriteria.map((c) => `- ${c}`));
  }

  sections.push("", "MACHINE EVIDENCE (already collected by the Gate; verify it yourself):", JSON.stringify(evidence, null, 2));

  sections.push(
    "",
    "Report every defect you can substantiate from the actual files.",
    "End your final message with exactly one line:",
    "VERDICT: PASS    (only if you found no real defect, or you found none that is in scope)",
    "VERDICT: FAIL    (if any in-scope defect remains)",
    "Emit exactly one of those two lines and nothing after it.",
  );

  return sections.join("\n");
}
