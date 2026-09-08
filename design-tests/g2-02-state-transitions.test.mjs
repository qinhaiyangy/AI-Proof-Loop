import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// This is an executable design contract for G2-02. The operation labels and
// in-memory shapes are deliberately abstract; G2-03 through G2-05 own runtime
// schemas, Event batches, hashes, and Evidence/Verdict payloads.

const fixturePath = new URL(
  "../docs/domain/examples/g2-02-transition-traces.json",
  import.meta.url,
);
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));

const activeAttemptStates = new Set(["STARTED", "EXECUTING", "VERIFYING"]);
const terminalRunStates = new Set(["FINISHED", "CANCELLED"]);
const terminalAttemptStates = new Set(["FINISHED", "INTERRUPTED", "CANCELLED"]);
const recoverySafetyWitness =
  "ALL_PRIOR_EFFECT_CAPABLE_WORK_STOPPED_OR_NEVER_STARTED_AND_WORKSPACE_RECONCILED";
const verificationStopUnknownWitness =
  "EFFECT_CAPABLE_VERIFICATION_DISPATCHED_BEFORE_CANCEL";
const effectQuiescenceWitness =
  "ALL_EFFECT_CAPABLE_WORK_STOPPED_OR_NEVER_STARTED";

function emptyState(taskIds) {
  return {
    tasks: Object.fromEntries(taskIds.map((taskId) => [taskId, { taskId }])),
    contracts: {},
    runs: {},
    attempts: {},
  };
}

function requireEntity(collection, id, label) {
  const entity = collection[id];
  if (!entity) throw new Error(`${label} ${id} does not exist`);
  return entity;
}

function requireState(entity, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(entity.state)) {
    throw new Error(`${label} must be ${allowed.join(" or ")}, not ${entity.state}`);
  }
}

function requireCancelFenceOpen(run, action) {
  if (run.cancelRequested) {
    throw new Error(`${action} cannot start new effectful work after cancellation was requested`);
  }
}

function postCancelConvergenceWasSafe(run, step) {
  if (!run.cancelRequested) {
    if (step.postCancelConvergence !== undefined) {
      throw new Error(
        "pre-cancellation adjudication cannot claim post-cancel convergence proof",
      );
    }
    return false;
  }
  if (step.postCancelConvergence !== "PRE_DISPATCHED_OR_CONTAINED") {
    throw new Error(
      "post-cancel adjudication needs proof that verification was pre-dispatched or effect-contained",
    );
  }
  return true;
}

function currentAttempt(state, run) {
  const attemptId = run.attemptIds.at(-1);
  return attemptId ? state.attempts[attemptId] : undefined;
}

function assertUniqueVerdictId(state, verdictId) {
  if (!verdictId) throw new Error("AttemptVerdict needs an identity");
  if (
    Object.values(state.attempts).some(
      (attempt) => attempt.verdict?.id === verdictId,
    )
  ) {
    throw new Error(`AttemptVerdict ${verdictId} already exists`);
  }
}

function assertUniqueRecoverySafetyProofId(state, proofId) {
  if (!proofId) throw new Error("Recovery safety proof needs an identity");
  if (
    Object.values(state.attempts).some(
      (attempt) => attempt.recoverySafetyProofId === proofId,
    )
  ) {
    throw new Error(`Recovery safety proof ${proofId} already exists`);
  }
}

function assertUniqueErrorId(state, errorId) {
  if (!errorId) throw new Error("Attempt interruption Error needs an identity");
  if (
    Object.values(state.attempts).some(
      (attempt) => attempt.errorIds.includes(errorId),
    )
  ) {
    throw new Error(`Attempt interruption Error ${errorId} already exists`);
  }
}

function assertUniqueEffectQuiescenceProofId(state, proofId) {
  if (!proofId) throw new Error("Policy terminalization proof needs an identity");
  if (
    Object.values(state.attempts).some(
      (attempt) => attempt.terminalEffectQuiescenceProofId === proofId,
    )
  ) {
    throw new Error(`Policy terminalization proof ${proofId} already exists`);
  }
}

function addAttempt(state, run, step, kind, parent, trigger) {
  if (!step.attemptId || state.attempts[step.attemptId]) {
    throw new Error("Attempt identity must be new and non-empty");
  }
  if (run.attemptIds.length >= run.maxAttempts) {
    throw new Error(`Run ${run.runId} has exhausted maxAttempts`);
  }
  const attempt = {
    attemptId: step.attemptId,
    runId: run.runId,
    kind,
    state: "STARTED",
    candidateId: null,
    parentAttemptId: parent?.attemptId ?? null,
    triggeringVerdictId: trigger?.verdictId ?? null,
    triggeringErrorId: trigger?.errorId ?? null,
    executorDispatchProvenance: null,
    terminalFromState: null,
    interruptionOrigin: null,
    recoveryDispositionAtInterruption: null,
    recoverySafetyProofId: null,
    unknownStopTarget: null,
    verificationStopUnknownProvenance: null,
    terminalEffectQuiescenceProofId: null,
    interruptionCancelRequestId: null,
    errorIds: [],
    verdict: null,
  };
  state.attempts[attempt.attemptId] = attempt;
  run.attemptIds.push(attempt.attemptId);
  return attempt;
}

function performOperation(state, step) {
  switch (step.op) {
    case "CREATE_CONTRACT_VERSION": {
      if (!state.tasks[step.taskId]) throw new Error("owning Task must exist");
      if (!step.contractId || state.contracts[step.contractId]) {
        throw new Error("Contract Version identity must be new and non-empty");
      }
      if (!Number.isInteger(step.order) || step.order < 1) {
        throw new Error("abstract Contract order must be a positive integer");
      }
      if (!step.contentHash) throw new Error("Contract candidate needs content identity");
      if (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 2) {
        throw new Error("v0.1 Contract maxAttempts must be an integer from 1 to 2");
      }
      state.contracts[step.contractId] = {
        contractId: step.contractId,
        taskId: step.taskId,
        order: step.order,
        contentHash: step.contentHash,
        maxAttempts: step.maxAttempts,
        state: "DRAFT",
        approved: false,
        approvedContentHash: null,
        approvedMaxAttempts: null,
        successorId: null,
      };
      break;
    }
    case "EDIT_CONTRACT_CONTENT": {
      const contract = requireEntity(state.contracts, step.contractId, "Contract Version");
      requireState(contract, ["DRAFT", "CLARIFYING"], "editable Contract Version");
      if (!step.contentHash || step.contentHash === contract.contentHash) {
        throw new Error("Contract edit needs a new content identity");
      }
      if (
        step.maxAttempts !== undefined &&
        (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 2)
      ) {
        throw new Error("v0.1 Contract maxAttempts must be an integer from 1 to 2");
      }
      contract.contentHash = step.contentHash;
      if (step.maxAttempts !== undefined) contract.maxAttempts = step.maxAttempts;
      break;
    }
    case "OPEN_CLARIFICATION": {
      const contract = requireEntity(state.contracts, step.contractId, "Contract Version");
      requireState(contract, "DRAFT", "Contract Version");
      contract.state = "CLARIFYING";
      break;
    }
    case "RESOLVE_CLARIFICATION": {
      const contract = requireEntity(state.contracts, step.contractId, "Contract Version");
      requireState(contract, "CLARIFYING", "Contract Version");
      contract.state = "DRAFT";
      break;
    }
    case "REQUEST_APPROVAL": {
      const contract = requireEntity(state.contracts, step.contractId, "Contract Version");
      requireState(contract, "DRAFT", "Contract Version");
      contract.state = "AWAITING_APPROVAL";
      break;
    }
    case "RETURN_FOR_CHANGES": {
      const contract = requireEntity(state.contracts, step.contractId, "Contract Version");
      requireState(contract, "AWAITING_APPROVAL", "Contract Version");
      if (contract.approved) throw new Error("an effective Approval cannot be returned to draft");
      contract.state = "DRAFT";
      break;
    }
    case "APPROVE_AND_FREEZE": {
      const contract = requireEntity(state.contracts, step.contractId, "Contract Version");
      requireState(contract, "AWAITING_APPROVAL", "Contract Version");
      const existing = Object.values(state.contracts).find(
        (candidate) =>
          candidate.taskId === contract.taskId &&
          candidate.contractId !== contract.contractId &&
          candidate.state === "FROZEN",
      );
      if (existing) {
        throw new Error("a replacement must atomically supersede the current FROZEN Contract Version");
      }
      contract.approved = true;
      contract.approvedContentHash = contract.contentHash;
      contract.approvedMaxAttempts = contract.maxAttempts;
      contract.state = "FROZEN";
      break;
    }
    case "APPROVE_FREEZE_AND_SUPERSEDE": {
      const successor = requireEntity(state.contracts, step.contractId, "successor Contract Version");
      const predecessor = requireEntity(state.contracts, step.predecessorId, "predecessor Contract Version");
      requireState(successor, "AWAITING_APPROVAL", "successor Contract Version");
      requireState(predecessor, "FROZEN", "predecessor Contract Version");
      if (successor.taskId !== predecessor.taskId) {
        throw new Error("successor must belong to the same Task");
      }
      if (successor.contractId === predecessor.contractId) {
        throw new Error("successor must be a different Contract Version");
      }
      if (successor.order <= predecessor.order) {
        throw new Error("successor must be later than its predecessor");
      }
      successor.approved = true;
      successor.approvedContentHash = successor.contentHash;
      successor.approvedMaxAttempts = successor.maxAttempts;
      successor.state = "FROZEN";
      predecessor.state = "SUPERSEDED";
      predecessor.successorId = successor.contractId;
      break;
    }
    case "CREATE_RUN": {
      const contract = requireEntity(state.contracts, step.contractId, "Contract Version");
      if (contract.state !== "FROZEN") {
        throw new Error("a new Run must bind a currently FROZEN Contract Version");
      }
      if (!step.runId || state.runs[step.runId]) {
        throw new Error("Run identity must be new and non-empty");
      }
      if (
        step.maxAttempts !== undefined &&
        step.maxAttempts !== contract.approvedMaxAttempts
      ) {
        throw new Error("Run maxAttempts must equal its Frozen Contract maxAttempts");
      }
      state.runs[step.runId] = {
        runId: step.runId,
        taskId: contract.taskId,
        contractId: contract.contractId,
        boundContractHash: contract.contentHash,
        maxAttempts: contract.approvedMaxAttempts,
        state: "QUEUED",
        attemptIds: [],
        cancelRequested: false,
        cancelRequestId: null,
        interruptionKind: null,
        interruptionCancelRequestId: null,
        diagnosticIds: [],
        outcome: null,
      };
      break;
    }
    case "START_PREFLIGHT": {
      const run = requireEntity(state.runs, step.runId, "Run");
      requireState(run, "QUEUED", "Run");
      requireCancelFenceOpen(run, "Preflight");
      run.state = "PREFLIGHT";
      break;
    }
    case "INTERRUPT_PREFLIGHT": {
      const run = requireEntity(state.runs, step.runId, "Run");
      requireState(run, "PREFLIGHT", "Run");
      if (run.attemptIds.length !== 0) throw new Error("Preflight interruption requires zero Attempts");
      run.state = "INTERRUPTED";
      run.interruptionKind = "PREFLIGHT";
      run.interruptionCancelRequestId = null;
      break;
    }
    case "PREFLIGHT_CHECK_FAILED": {
      const run = requireEntity(state.runs, step.runId, "Run");
      requireState(run, "PREFLIGHT", "Run");
      if (run.attemptIds.length !== 0) throw new Error("Preflight diagnostic requires zero Attempts");
      if (!step.diagnosticId) throw new Error("Preflight diagnostic needs an identity");
      if (run.diagnosticIds.includes(step.diagnosticId)) {
        throw new Error("Preflight diagnostic identity must be new within its Run");
      }
      run.diagnosticIds.push(step.diagnosticId);
      break;
    }
    case "RETRY_PREFLIGHT": {
      const run = requireEntity(state.runs, step.runId, "Run");
      requireState(run, "INTERRUPTED", "Run");
      if (run.attemptIds.length !== 0) {
        throw new Error("Preflight retry is only for a zero-Attempt interruption");
      }
      requireCancelFenceOpen(run, "Preflight retry");
      run.state = "PREFLIGHT";
      run.interruptionKind = null;
      run.interruptionCancelRequestId = null;
      break;
    }
    case "START_INITIAL_ATTEMPT": {
      const run = requireEntity(state.runs, step.runId, "Run");
      requireState(run, "PREFLIGHT", "Run");
      requireCancelFenceOpen(run, "Initial Attempt");
      if (run.attemptIds.length !== 0) throw new Error("Initial Attempt must be first");
      addAttempt(state, run, step, "INITIAL", null, null);
      run.state = "ACTIVE";
      break;
    }
    case "START_EXECUTION": {
      const attempt = requireEntity(state.attempts, step.attemptId, "Attempt");
      const run = requireEntity(state.runs, attempt.runId, "Run");
      requireState(attempt, "STARTED", "Attempt");
      requireState(run, "ACTIVE", "Run");
      requireCancelFenceOpen(run, "Executor");
      if (currentAttempt(state, run)?.attemptId !== attempt.attemptId) {
        throw new Error("only the current Attempt may execute");
      }
      attempt.executorDispatchProvenance = "START_ACKNOWLEDGED";
      attempt.state = "EXECUTING";
      break;
    }
    case "EXECUTOR_FINISHED": {
      const attempt = requireEntity(state.attempts, step.attemptId, "Attempt");
      const run = requireEntity(state.runs, attempt.runId, "Run");
      requireState(attempt, ["STARTED", "EXECUTING"], "Attempt");
      requireState(run, "ACTIVE", "Run");
      if (attempt.state === "STARTED") {
        const requiredProvenance = run.cancelRequested
          ? "DISPATCHED_BEFORE_CANCEL"
          : "DISPATCHED_WITHOUT_START_ACK";
        if (step.dispatchProvenance !== requiredProvenance) {
          throw new Error(
            `STARTED completion needs ${requiredProvenance} provenance`,
          );
        }
        attempt.executorDispatchProvenance = step.dispatchProvenance;
      }
      if (!step.candidateId) throw new Error("Executor finished needs a stable Candidate");
      attempt.candidateId = step.candidateId;
      attempt.state = "VERIFYING";
      run.state = "VERIFYING";
      break;
    }
    case "RECORD_PASSED_VERDICT": {
      const attempt = requireEntity(state.attempts, step.attemptId, "Attempt");
      const run = requireEntity(state.runs, attempt.runId, "Run");
      requireState(attempt, "VERIFYING", "Attempt");
      requireState(run, "VERIFYING", "Run");
      assertUniqueVerdictId(state, step.verdictId);
      const postCancelConvergenceSafe = postCancelConvergenceWasSafe(run, step);
      attempt.verdict = {
        id: step.verdictId,
        value: "PASSED",
        postCancelConvergenceSafe,
      };
      attempt.terminalFromState = "VERIFYING";
      attempt.state = "FINISHED";
      run.state = "FINISHED";
      run.outcome = {
        value: "PASSED",
        finalAttemptVerdictId: step.verdictId,
      };
      break;
    }
    case "RECORD_FAILED_VERDICT": {
      const attempt = requireEntity(state.attempts, step.attemptId, "Attempt");
      const run = requireEntity(state.runs, attempt.runId, "Run");
      requireState(attempt, "VERIFYING", "Attempt");
      requireState(run, "VERIFYING", "Run");
      assertUniqueVerdictId(state, step.verdictId);
      const postCancelConvergenceSafe = postCancelConvergenceWasSafe(run, step);
      attempt.verdict = {
        id: step.verdictId,
        value: "FAILED",
        postCancelConvergenceSafe,
      };
      attempt.terminalFromState = "VERIFYING";
      attempt.state = "FINISHED";
      if (run.attemptIds.length < run.maxAttempts) {
        run.state = "AWAITING_REPAIR";
      } else {
        run.state = "FINISHED";
        run.outcome = {
          value: "FAILED",
          finalAttemptVerdictId: step.verdictId,
        };
      }
      break;
    }
    case "DECLINE_REPAIR": {
      const run = requireEntity(state.runs, step.runId, "Run");
      requireState(run, "AWAITING_REPAIR", "Run");
      const attempt = currentAttempt(state, run);
      if (attempt?.state !== "FINISHED" || attempt.verdict?.value !== "FAILED") {
        throw new Error("Repair can be declined only after a final FAILED Attempt");
      }
      run.state = "FINISHED";
      run.outcome = {
        value: "FAILED",
        finalAttemptVerdictId: attempt.verdict.id,
      };
      break;
    }
    case "START_REPAIR_ATTEMPT": {
      const run = requireEntity(state.runs, step.runId, "Run");
      requireState(run, "AWAITING_REPAIR", "Run");
      requireCancelFenceOpen(run, "Repair Attempt");
      const parent = currentAttempt(state, run);
      if (parent?.state !== "FINISHED" || parent.verdict?.value !== "FAILED") {
        throw new Error("Repair parent must be the final FINISHED + FAILED Attempt");
      }
      addAttempt(state, run, step, "REPAIR", parent, {
        verdictId: parent.verdict.id,
      });
      run.state = "ACTIVE";
      break;
    }
    case "INTERRUPT_ATTEMPT": {
      const attempt = requireEntity(state.attempts, step.attemptId, "Attempt");
      const run = requireEntity(state.runs, attempt.runId, "Run");
      requireState(attempt, ["STARTED", "EXECUTING", "VERIFYING"], "Attempt");
      requireState(run, ["ACTIVE", "VERIFYING"], "Run");
      assertUniqueVerdictId(state, step.verdictId);
      const terminalFromState = attempt.state;
      const recoveryWasProvenSafe = step.recoverySafety === recoverySafetyWitness;
      if (recoveryWasProvenSafe) {
        assertUniqueRecoverySafetyProofId(state, step.recoverySafetyProofId);
      } else if (
        step.recoverySafety !== undefined ||
        step.recoverySafetyProofId !== undefined
      ) {
        throw new Error("Recovery safety proof identity needs the matching safety witness");
      }
      if (step.errorId !== undefined) {
        assertUniqueErrorId(state, step.errorId);
        attempt.errorIds.push(step.errorId);
      }
      attempt.verdict = { id: step.verdictId, value: "INCONCLUSIVE" };
      attempt.terminalFromState = terminalFromState;
      attempt.state = "INTERRUPTED";
      attempt.interruptionOrigin = "ORDINARY";
      attempt.recoveryDispositionAtInterruption = recoveryWasProvenSafe
        ? "SAFE_TO_CREATE_REPAIR"
        : "RECONCILIATION_REQUIRED";
      attempt.recoverySafetyProofId = recoveryWasProvenSafe
        ? step.recoverySafetyProofId
        : null;
      attempt.interruptionCancelRequestId = null;
      if (run.attemptIds.length < run.maxAttempts) {
        run.state = "INTERRUPTED";
        run.interruptionKind = "ATTEMPT";
        run.interruptionCancelRequestId = null;
      } else {
        run.state = "FINISHED";
        run.interruptionKind = null;
        run.interruptionCancelRequestId = null;
        run.outcome = {
          value: "INCONCLUSIVE",
          finalAttemptVerdictId: step.verdictId,
        };
      }
      break;
    }
    case "CONFIRM_RECOVERY_SAFETY": {
      const attempt = requireEntity(state.attempts, step.attemptId, "Attempt");
      const run = requireEntity(state.runs, attempt.runId, "Run");
      requireState(run, "INTERRUPTED", "Run");
      requireState(attempt, "INTERRUPTED", "Attempt");
      requireCancelFenceOpen(run, "Recovery safety confirmation");
      if (
        currentAttempt(state, run)?.attemptId !== attempt.attemptId ||
        run.interruptionKind !== "ATTEMPT" ||
        attempt.interruptionOrigin !== "ORDINARY" ||
        attempt.verdict?.value !== "INCONCLUSIVE"
      ) {
        throw new Error(
          "Recovery safety confirmation needs the latest ordinary INTERRUPTED + INCONCLUSIVE Attempt",
        );
      }
      if (attempt.recoveryDispositionAtInterruption !== "RECONCILIATION_REQUIRED") {
        throw new Error("Recovery safety was already proven when interruption was recorded");
      }
      if (attempt.recoverySafetyProofId) {
        throw new Error("Recovery safety confirmation is already recorded");
      }
      if (step.recoverySafety !== recoverySafetyWitness) {
        throw new Error(
          "Recovery safety confirmation requires all prior effect-capable Executor or verifier work to stop or never start, plus workspace reconciliation",
        );
      }
      assertUniqueRecoverySafetyProofId(state, step.recoverySafetyProofId);
      attempt.recoverySafetyProofId = step.recoverySafetyProofId;
      break;
    }
    case "START_RECOVERY_ATTEMPT": {
      const run = requireEntity(state.runs, step.runId, "Run");
      requireState(run, "INTERRUPTED", "Run");
      requireCancelFenceOpen(run, "Recovery Attempt");
      const parent = currentAttempt(state, run);
      if (parent?.state !== "INTERRUPTED" || parent.verdict?.value !== "INCONCLUSIVE") {
        throw new Error("Recovery needs a final INTERRUPTED + INCONCLUSIVE Attempt");
      }
      if (!parent.recoverySafetyProofId) {
        throw new Error(
          "Recovery requires proof that all prior effect-capable Executor or verifier work stopped or never started and the workspace was reconciled",
        );
      }
      let trigger;
      if (step.trigger === "error") {
        const errorId = parent.errorIds.at(-1);
        if (!errorId) throw new Error("Recovery Error trigger must belong to its parent");
        trigger = { errorId };
      } else if (step.trigger === "verdict") {
        trigger = { verdictId: parent.verdict.id };
      } else {
        throw new Error("Recovery needs exactly one Verdict-or-Error trigger");
      }
      addAttempt(state, run, step, "REPAIR", parent, trigger);
      run.state = "ACTIVE";
      run.interruptionKind = null;
      run.interruptionCancelRequestId = null;
      break;
    }
    case "END_INTERRUPTED_RUN": {
      const run = requireEntity(state.runs, step.runId, "Run");
      requireState(run, "INTERRUPTED", "Run");
      const attempt = currentAttempt(state, run);
      if (!attempt || attempt.state !== "INTERRUPTED" || attempt.verdict?.value !== "INCONCLUSIVE") {
        throw new Error("ending an interrupted Run needs at least one INCONCLUSIVE Attempt");
      }
      run.state = "FINISHED";
      run.interruptionKind = null;
      run.interruptionCancelRequestId = null;
      run.outcome = {
        value: "INCONCLUSIVE",
        finalAttemptVerdictId: attempt.verdict.id,
      };
      break;
    }
    case "PREFLIGHT_POLICY_BLOCKED": {
      const run = requireEntity(state.runs, step.runId, "Run");
      requireState(run, "PREFLIGHT", "Run");
      if (run.attemptIds.length !== 0) {
        throw new Error("pre-Attempt Policy block requires zero Attempts");
      }
      if (!step.terminalEventId) throw new Error("Policy block needs a terminal Event");
      run.state = "FINISHED";
      run.outcome = {
        value: "POLICY_BLOCKED",
        terminalEventId: step.terminalEventId,
      };
      break;
    }
    case "IN_ATTEMPT_POLICY_BLOCKED": {
      const attempt = requireEntity(state.attempts, step.attemptId, "Attempt");
      const run = requireEntity(state.runs, attempt.runId, "Run");
      requireState(attempt, ["STARTED", "EXECUTING", "VERIFYING"], "Attempt");
      requireState(run, attempt.state === "VERIFYING" ? "VERIFYING" : "ACTIVE", "Run");
      if (step.effectQuiescence !== effectQuiescenceWitness) {
        throw new Error(
          "in-Attempt Policy terminalization requires all effect-capable work to be stopped or never started",
        );
      }
      assertUniqueEffectQuiescenceProofId(state, step.effectQuiescenceProofId);
      assertUniqueVerdictId(state, step.verdictId);
      attempt.terminalFromState = attempt.state;
      attempt.terminalEffectQuiescenceProofId = step.effectQuiescenceProofId;
      attempt.verdict = { id: step.verdictId, value: "POLICY_BLOCKED" };
      attempt.state = "FINISHED";
      run.state = "FINISHED";
      run.outcome = {
        value: "POLICY_BLOCKED",
        finalAttemptVerdictId: step.verdictId,
      };
      break;
    }
    case "REQUEST_CANCEL": {
      const run = requireEntity(state.runs, step.runId, "Run");
      if (terminalRunStates.has(run.state)) throw new Error("terminal Run cannot request cancellation");
      if (run.state === "AWAITING_REPAIR") {
        throw new Error("AWAITING_REPAIR must end through Repair or a FAILED RunOutcome");
      }
      if (run.state === "INTERRUPTED" && run.interruptionKind === "ATTEMPT") {
        throw new Error("Attempt interruption must end INCONCLUSIVE or start Recovery");
      }
      if (!step.cancelRequestId) throw new Error("cancellation request needs an identity");
      if (run.cancelRequestId && run.cancelRequestId !== step.cancelRequestId) {
        throw new Error("a Run cannot replace its pending cancellation request");
      }
      run.cancelRequested = true;
      run.cancelRequestId = step.cancelRequestId;
      break;
    }
    case "CONFIRM_CANCEL": {
      const run = requireEntity(state.runs, step.runId, "Run");
      if (terminalRunStates.has(run.state)) throw new Error("terminal Run cannot be cancelled again");
      if (!run.cancelRequested) {
        throw new Error("cancellation must be requested before it is confirmed");
      }
      if (!step.cancelRequestId || step.cancelRequestId !== run.cancelRequestId) {
        throw new Error("cancellation confirmation must match the pending request");
      }
      if (run.state === "AWAITING_REPAIR") {
        throw new Error("AWAITING_REPAIR cannot be washed into cancellation");
      }
      if (
        run.state === "INTERRUPTED" &&
        !["PREFLIGHT", "CANCEL_STOP_UNKNOWN"].includes(run.interruptionKind)
      ) {
        throw new Error("only a Preflight abandonment or matching late stop confirmation may cancel INTERRUPTED");
      }
      if (!step.terminalEventId) throw new Error("confirmed cancellation needs a terminal Event");
      const attempt = currentAttempt(state, run);
      let cancelSource = "NO_ATTEMPT";
      if (attempt && activeAttemptStates.has(attempt.state)) {
        attempt.terminalFromState = attempt.state;
        attempt.state = "CANCELLED";
        attempt.verdict = null;
        attempt.interruptionCancelRequestId = null;
        cancelSource = "ACTIVE_STOP_CONFIRMED";
      } else if (attempt?.state === "INTERRUPTED") {
        if (
          run.interruptionKind !== "CANCEL_STOP_UNKNOWN" ||
          run.interruptionCancelRequestId !== run.cancelRequestId ||
          attempt.interruptionCancelRequestId !== run.cancelRequestId
        ) {
          throw new Error("late cancellation confirmation must match the unknown-stop request");
        }
        cancelSource = "LATE_STOP_CONFIRMED";
      }
      run.state = "CANCELLED";
      run.interruptionKind = null;
      run.interruptionCancelRequestId = null;
      run.outcome = {
        value: "CANCELLED",
        terminalEventId: step.terminalEventId,
        cancelRequestId: run.cancelRequestId,
        cancelSource,
      };
      break;
    }
    case "STOP_RESULT_UNKNOWN": {
      const run = requireEntity(state.runs, step.runId, "Run");
      requireState(run, ["ACTIVE", "VERIFYING"], "Run");
      if (!run.cancelRequested) throw new Error("unknown stop result requires a cancellation request");
      const attempt = currentAttempt(state, run);
      if (!attempt || !activeAttemptStates.has(attempt.state)) {
        throw new Error("unknown stop result needs one Active Attempt");
      }
      const terminalFromState = attempt.state;
      if (terminalFromState === "STARTED") {
        if (step.dispatchProvenance !== "DISPATCHED_BEFORE_CANCEL") {
          throw new Error("STARTED unknown stop needs DISPATCHED_BEFORE_CANCEL provenance");
        }
        if (step.verificationStopProvenance !== undefined) {
          throw new Error("Executor unknown stop cannot claim verifier-stop provenance");
        }
        attempt.executorDispatchProvenance = step.dispatchProvenance;
        attempt.unknownStopTarget = "EXECUTOR";
      } else if (terminalFromState === "EXECUTING") {
        if (step.dispatchProvenance !== undefined) {
          throw new Error("acknowledged Executor unknown stop cannot replace dispatch provenance");
        }
        if (step.verificationStopProvenance !== undefined) {
          throw new Error("Executor unknown stop cannot claim verifier-stop provenance");
        }
        attempt.unknownStopTarget = "EXECUTOR";
      } else {
        if (step.dispatchProvenance !== undefined) {
          throw new Error("VERIFYING unknown stop cannot claim active Executor dispatch provenance");
        }
        if (step.verificationStopProvenance !== verificationStopUnknownWitness) {
          throw new Error(
            "VERIFYING unknown stop needs pre-cancel effect-capable verifier dispatch provenance",
          );
        }
        attempt.unknownStopTarget = "VERIFICATION";
        attempt.verificationStopUnknownProvenance = step.verificationStopProvenance;
      }
      assertUniqueVerdictId(state, step.verdictId);
      attempt.terminalFromState = terminalFromState;
      attempt.verdict = { id: step.verdictId, value: "INCONCLUSIVE" };
      attempt.state = "INTERRUPTED";
      attempt.interruptionOrigin = "CANCEL_STOP_UNKNOWN";
      attempt.recoveryDispositionAtInterruption = "RECONCILIATION_REQUIRED";
      attempt.recoverySafetyProofId = null;
      attempt.interruptionCancelRequestId = run.cancelRequestId;
      run.state = "INTERRUPTED";
      run.interruptionKind = "CANCEL_STOP_UNKNOWN";
      run.interruptionCancelRequestId = run.cancelRequestId;
      break;
    }
    default:
      throw new Error(`unknown abstract operation ${step.op}`);
  }
}

function validateState(state) {
  const errors = [];
  const contractStates = new Set(fixtures.machines.CONTRACT_VERSION.states);
  const runStates = new Set(fixtures.machines.RUN.states);
  const attemptStates = new Set(fixtures.machines.ATTEMPT.states);
  const dispatchProvenanceValues = new Set([
    null,
    "START_ACKNOWLEDGED",
    "DISPATCHED_WITHOUT_START_ACK",
    "DISPATCHED_BEFORE_CANCEL",
  ]);

  for (const [taskKey, task] of Object.entries(state.tasks)) {
    if (!task.taskId || task.taskId !== taskKey) {
      errors.push(`Task ${taskKey} needs a stable matching identity`);
    }
  }

  for (const [contractKey, contract] of Object.entries(state.contracts)) {
    if (!contract.contractId || contract.contractId !== contractKey) {
      errors.push(`Contract Version ${contractKey} needs a stable matching identity`);
    }
    if (!state.tasks[contract.taskId]) {
      errors.push(`Contract Version ${contract.contractId} needs exactly one owning Task`);
    }
    if (!Number.isInteger(contract.order) || contract.order < 1) {
      errors.push(`Contract Version ${contract.contractId} needs a positive order`);
    }
    if (typeof contract.contentHash !== "string" || contract.contentHash.length === 0) {
      errors.push(`Contract Version ${contract.contractId} needs a non-empty content identity`);
    }
    if (!contractStates.has(contract.state)) {
      errors.push(`Contract Version ${contract.contractId} has an unknown state`);
    }
    if (["DRAFT", "CLARIFYING", "AWAITING_APPROVAL"].includes(contract.state)) {
      if (
        contract.approved ||
        contract.approvedContentHash ||
        contract.approvedMaxAttempts !== null ||
        contract.successorId
      ) {
        errors.push(`Unfrozen Contract Version ${contract.contractId} cannot have Approval or successor`);
      }
    }
    if (
      !Number.isInteger(contract.maxAttempts) ||
      contract.maxAttempts < 1 ||
      contract.maxAttempts > 2
    ) {
      errors.push(`Contract Version ${contract.contractId} has invalid v0.1 maxAttempts`);
    }
    if (
      ["FROZEN", "SUPERSEDED"].includes(contract.state) &&
      (
        !contract.approved ||
        contract.approvedContentHash !== contract.contentHash ||
        contract.approvedMaxAttempts !== contract.maxAttempts
      )
    ) {
      errors.push(
        `Executable history ${contract.contractId} needs Approval for its exact content identity and maxAttempts`,
      );
    }
    if (contract.state === "FROZEN" && contract.successorId) {
      errors.push(`Current FROZEN Contract Version ${contract.contractId} cannot name a successor`);
    }
    if (contract.state === "SUPERSEDED") {
      const successor = state.contracts[contract.successorId];
      if (
        !successor ||
        successor.taskId !== contract.taskId ||
        successor.contractId === contract.contractId ||
        successor.order <= contract.order ||
        !["FROZEN", "SUPERSEDED"].includes(successor.state)
      ) {
        errors.push(`SUPERSEDED Contract Version ${contract.contractId} needs a later same-Task frozen successor`);
      }
    }
  }

  for (const task of Object.values(state.tasks)) {
    const seenOrders = new Set();
    for (const contract of Object.values(state.contracts).filter(
      (candidate) => candidate.taskId === task.taskId,
    )) {
      if (seenOrders.has(contract.order)) {
        errors.push(`Task ${task.taskId} has duplicate Contract Version order ${contract.order}`);
      }
      seenOrders.add(contract.order);
    }
    const currentFrozen = Object.values(state.contracts).filter(
      (contract) => contract.taskId === task.taskId && contract.state === "FROZEN",
    );
    if (currentFrozen.length > 1) {
      errors.push(`Task ${task.taskId} has more than one current FROZEN Contract Version`);
    }
  }

  const predecessorCounts = new Map();
  for (const contract of Object.values(state.contracts)) {
    if (!contract.successorId) continue;
    predecessorCounts.set(
      contract.successorId,
      (predecessorCounts.get(contract.successorId) ?? 0) + 1,
    );
  }
  for (const [successorId, count] of predecessorCounts) {
    if (count > 1) {
      errors.push(`Contract Version ${successorId} has more than one direct predecessor`);
    }
  }

  for (const contract of Object.values(state.contracts)) {
    const seen = new Set();
    let cursor = contract;
    while (cursor?.successorId) {
      if (seen.has(cursor.contractId)) {
        errors.push(`Contract successor chain contains a cycle at ${cursor.contractId}`);
        break;
      }
      seen.add(cursor.contractId);
      cursor = state.contracts[cursor.successorId];
    }
  }

  for (const [runKey, run] of Object.entries(state.runs)) {
    if (!run.runId || run.runId !== runKey) {
      errors.push(`Run ${runKey} needs a stable matching identity`);
    }
    if (!runStates.has(run.state)) errors.push(`Run ${run.runId} has an unknown state`);
    const contract = state.contracts[run.contractId];
    if (
      !contract ||
      !["FROZEN", "SUPERSEDED"].includes(contract.state) ||
      run.taskId !== contract.taskId ||
      run.boundContractHash !== contract.approvedContentHash ||
      run.maxAttempts !== contract.approvedMaxAttempts
    ) {
      errors.push(`Run ${run.runId} lost its exact frozen Contract binding`);
    }
    if (!Number.isInteger(run.maxAttempts) || run.maxAttempts < 1 || run.maxAttempts > 2) {
      errors.push(`Run ${run.runId} has invalid v0.1 maxAttempts`);
    }
    if (run.cancelRequested !== Boolean(run.cancelRequestId)) {
      errors.push(`Run ${run.runId} cancellation fact and request identity must agree`);
    }
    if (!Array.isArray(run.diagnosticIds)) {
      errors.push(`Run ${run.runId} needs an append-only diagnostic identity list`);
    } else {
      if (
        run.diagnosticIds.some(
          (diagnosticId) => typeof diagnosticId !== "string" || diagnosticId.length === 0,
        )
      ) {
        errors.push(`Run ${run.runId} diagnostic identities must be non-empty strings`);
      }
      if (new Set(run.diagnosticIds).size !== run.diagnosticIds.length) {
        errors.push(`Run ${run.runId} has duplicate diagnostic identities`);
      }
      if (run.state === "QUEUED" && run.diagnosticIds.length !== 0) {
        errors.push(`QUEUED Run ${run.runId} cannot contain Preflight diagnostics`);
      }
    }
    if (!Array.isArray(run.attemptIds)) {
      errors.push(`Run ${run.runId} needs an ordered Attempt identity list`);
      continue;
    }
    if (new Set(run.attemptIds).size !== run.attemptIds.length) {
      errors.push(`Run ${run.runId} has duplicate Attempt identities in sequence`);
    }
    const attempts = run.attemptIds.map((attemptId) => state.attempts[attemptId]);
    if (attempts.some((attempt) => !attempt || attempt.runId !== run.runId)) {
      errors.push(`Run ${run.runId} has invalid Attempt ownership`);
      continue;
    }
    if (attempts.length > run.maxAttempts) errors.push(`Run ${run.runId} exceeds maxAttempts`);
    const active = attempts.filter((attempt) => activeAttemptStates.has(attempt.state));
    if (active.length > 1) errors.push(`Run ${run.runId} has more than one Active Attempt`);
    const latest = attempts.at(-1);
    const terminal = terminalRunStates.has(run.state);
    if (terminal !== Boolean(run.outcome)) {
      errors.push(`Run ${run.runId} terminal lifecycle and RunOutcome must appear together`);
    }
    if (!terminal && run.outcome) errors.push(`Nonterminal Run ${run.runId} cannot have RunOutcome`);

    if (["QUEUED", "PREFLIGHT"].includes(run.state) && attempts.length !== 0) {
      errors.push(`Run ${run.runId} cannot have Attempts before Preflight passes`);
    }
    if (run.state === "ACTIVE") {
      if (active.length !== 1 || !["STARTED", "EXECUTING"].includes(latest?.state)) {
        errors.push(`ACTIVE Run ${run.runId} needs one current STARTED or EXECUTING Attempt`);
      }
    }
    if (run.state === "VERIFYING") {
      if (active.length !== 1 || latest?.state !== "VERIFYING") {
        errors.push(`VERIFYING Run ${run.runId} needs one current VERIFYING Attempt`);
      }
    }
    if (run.state === "AWAITING_REPAIR") {
      if (
        active.length !== 0 ||
        latest?.state !== "FINISHED" ||
        latest?.verdict?.value !== "FAILED" ||
        attempts.length >= run.maxAttempts
      ) {
        errors.push(`AWAITING_REPAIR Run ${run.runId} needs a final FAILED Attempt and remaining quota`);
      }
      if (run.cancelRequested && latest?.verdict?.postCancelConvergenceSafe !== true) {
        errors.push(`post-cancel FAILED Run ${run.runId} needs safe convergence proof`);
      }
    }
    if (run.state === "INTERRUPTED") {
      const zeroAttemptPreflight = attempts.length === 0;
      const interruptedAttempt =
        latest?.state === "INTERRUPTED" && latest?.verdict?.value === "INCONCLUSIVE";
      if (active.length !== 0 || (!zeroAttemptPreflight && !interruptedAttempt)) {
        errors.push(`INTERRUPTED Run ${run.runId} needs zero Attempts or a final INCONCLUSIVE Attempt`);
      }
      if (!["PREFLIGHT", "ATTEMPT", "CANCEL_STOP_UNKNOWN"].includes(run.interruptionKind)) {
        errors.push(`INTERRUPTED Run ${run.runId} needs a known interruption kind`);
      } else if (zeroAttemptPreflight) {
        if (run.interruptionKind !== "PREFLIGHT" || run.interruptionCancelRequestId) {
          errors.push(`zero-Attempt INTERRUPTED Run ${run.runId} must be PREFLIGHT`);
        }
      } else if (interruptedAttempt) {
        if (run.interruptionKind === "PREFLIGHT") {
          errors.push(`Attempt-level INTERRUPTED Run ${run.runId} cannot be PREFLIGHT`);
        }
        if (run.interruptionKind === "ATTEMPT") {
          if (
            attempts.length >= run.maxAttempts ||
            run.interruptionCancelRequestId ||
            latest.interruptionOrigin !== "ORDINARY" ||
            latest.interruptionCancelRequestId
          ) {
            errors.push(`ordinary Attempt interruption ${run.runId} needs remaining quota and no cancellation provenance`);
          }
        }
        if (run.interruptionKind === "CANCEL_STOP_UNKNOWN") {
          if (
            !run.cancelRequested ||
            run.interruptionCancelRequestId !== run.cancelRequestId ||
            latest.interruptionOrigin !== "CANCEL_STOP_UNKNOWN" ||
            latest.interruptionCancelRequestId !== run.cancelRequestId
          ) {
            errors.push(`unknown-stop interruption ${run.runId} must match its pending cancellation request`);
          }
          if (latest.executorDispatchProvenance === null) {
            errors.push(
              `unknown-stop interruption ${run.runId} needs retained Executor dispatch provenance`,
            );
          }
        }
      }
    } else if (run.interruptionKind || run.interruptionCancelRequestId) {
      errors.push(`Only INTERRUPTED Run ${run.runId} may retain current interruption metadata`);
    }
    if (terminal && active.length !== 0) {
      errors.push(`Terminal Run ${run.runId} cannot retain an Active Attempt`);
    }

    if (run.outcome) {
      const hasVerdictBasis = Boolean(run.outcome.finalAttemptVerdictId);
      const hasEventBasis = Boolean(run.outcome.terminalEventId);
      if (Number(hasVerdictBasis) + Number(hasEventBasis) !== 1) {
        errors.push(`RunOutcome for ${run.runId} needs exactly one terminal basis`);
      }
      if (run.state === "CANCELLED") {
        if (run.outcome.value !== "CANCELLED" || !hasEventBasis) {
          errors.push(`CANCELLED Run ${run.runId} needs a cancellation Event-based Outcome`);
        }
        if (!run.cancelRequested || run.outcome.cancelRequestId !== run.cancelRequestId) {
          errors.push(`CANCELLED Run ${run.runId} must retain its matching cancellation request`);
        }
        if (attempts.length === 0) {
          if (run.outcome.cancelSource !== "NO_ATTEMPT") {
            errors.push(`zero-Attempt CANCELLED Run ${run.runId} needs NO_ATTEMPT source`);
          }
        } else if (latest?.state === "CANCELLED" && !latest.verdict) {
          if (run.outcome.cancelSource !== "ACTIVE_STOP_CONFIRMED") {
            errors.push(`active-stop CANCELLED Run ${run.runId} needs ACTIVE_STOP_CONFIRMED source`);
          }
        } else if (
          latest?.state === "INTERRUPTED" &&
          latest?.verdict?.value === "INCONCLUSIVE" &&
          latest?.interruptionOrigin === "CANCEL_STOP_UNKNOWN" &&
          latest?.interruptionCancelRequestId === run.cancelRequestId
        ) {
          if (run.outcome.cancelSource !== "LATE_STOP_CONFIRMED") {
            errors.push(`late-confirmed CANCELLED Run ${run.runId} needs LATE_STOP_CONFIRMED source`);
          }
        } else {
          errors.push(`CANCELLED Run ${run.runId} has an illegal final Attempt shape`);
        }
      } else if (run.outcome.value === "CANCELLED") {
        errors.push(`FINISHED Run ${run.runId} cannot have CANCELLED Outcome`);
      }
      if (hasVerdictBasis) {
        if (!latest?.verdict || latest.verdict.id !== run.outcome.finalAttemptVerdictId) {
          errors.push(`RunOutcome for ${run.runId} must cite the final AttemptVerdict`);
        } else if (latest.verdict.value !== run.outcome.value) {
          errors.push(`RunOutcome for ${run.runId} must match its final AttemptVerdict`);
        }
        if (run.outcome.value === "INCONCLUSIVE" && latest?.state !== "INTERRUPTED") {
          errors.push(`INCONCLUSIVE RunOutcome for ${run.runId} needs an INTERRUPTED Attempt`);
        }
        if (["PASSED", "FAILED", "POLICY_BLOCKED"].includes(run.outcome.value) && latest?.state !== "FINISHED") {
          errors.push(`${run.outcome.value} RunOutcome for ${run.runId} needs a FINISHED Attempt`);
        }
        if (
          run.cancelRequested &&
          ["PASSED", "FAILED"].includes(run.outcome.value) &&
          latest?.verdict?.postCancelConvergenceSafe !== true
        ) {
          errors.push(`post-cancel ${run.outcome.value} Run ${run.runId} needs safe convergence proof`);
        }
      }
      if (hasEventBasis) {
        if (run.outcome.value === "POLICY_BLOCKED" && attempts.length !== 0) {
          errors.push(`Event-based POLICY_BLOCKED Run ${run.runId} requires zero Attempts`);
        }
        if (!["POLICY_BLOCKED", "CANCELLED"].includes(run.outcome.value)) {
          errors.push(`Only POLICY_BLOCKED or CANCELLED RunOutcome may use terminal Event basis`);
        }
      }
    }
  }

  const seenVerdictIds = new Set();
  const seenRecoverySafetyProofIds = new Set();
  const seenErrorIds = new Set();
  const seenEffectQuiescenceProofIds = new Set();
  for (const [attemptKey, attempt] of Object.entries(state.attempts)) {
    if (!attempt.attemptId || attempt.attemptId !== attemptKey) {
      errors.push(`Attempt ${attemptKey} needs a stable matching identity`);
    }
    if (!attemptStates.has(attempt.state)) errors.push(`Attempt ${attempt.attemptId} has an unknown state`);
    const run = state.runs[attempt.runId];
    if (
      !run ||
      !Array.isArray(run.attemptIds) ||
      !run.attemptIds.includes(attempt.attemptId)
    ) {
      errors.push(`Attempt ${attempt.attemptId} has no owning Run`);
      continue;
    }
    if (attempt.verdict) {
      if (typeof attempt.verdict.id !== "string" || attempt.verdict.id.length === 0) {
        errors.push(`AttemptVerdict on ${attempt.attemptId} needs a non-empty identity`);
      } else if (seenVerdictIds.has(attempt.verdict.id)) {
        errors.push(`AttemptVerdict ${attempt.verdict.id} identity is duplicated`);
      } else {
        seenVerdictIds.add(attempt.verdict.id);
      }
    }
    const isLatestAttempt = run.attemptIds.at(-1) === attempt.attemptId;
    const hasPostCancelMarker = Boolean(
      attempt.verdict &&
      Object.hasOwn(attempt.verdict, "postCancelConvergenceSafe"),
    );
    if (["PASSED", "FAILED"].includes(attempt.verdict?.value)) {
      if (
        !hasPostCancelMarker ||
        typeof attempt.verdict.postCancelConvergenceSafe !== "boolean"
      ) {
        errors.push(
          `${attempt.verdict.value} Attempt ${attempt.attemptId} needs a boolean post-cancel convergence marker`,
        );
      } else {
        if (
          attempt.verdict.postCancelConvergenceSafe &&
          (!run.cancelRequested || !isLatestAttempt)
        ) {
          errors.push(
            `post-cancel convergence marker on ${attempt.attemptId} needs a retained cancellation request and the final Attempt position`,
          );
        }
        if (
          isLatestAttempt &&
          attempt.verdict.postCancelConvergenceSafe !== run.cancelRequested
        ) {
          errors.push(
            `final ${attempt.verdict.value} Attempt ${attempt.attemptId} must exactly reflect whether adjudication followed cancellation`,
          );
        }
      }
    } else if (hasPostCancelMarker) {
      errors.push(
        `Only PASSED or FAILED AttemptVerdict may carry post-cancel convergence metadata`,
      );
    }
    if (!Array.isArray(attempt.errorIds)) {
      errors.push(`Attempt ${attempt.attemptId} needs an append-only interruption Error identity list`);
    } else {
      for (const errorId of attempt.errorIds) {
        if (typeof errorId !== "string" || errorId.length === 0) {
          errors.push(`Attempt ${attempt.attemptId} interruption Error identities must be non-empty strings`);
        } else if (seenErrorIds.has(errorId)) {
          errors.push(`Attempt interruption Error identity ${errorId} is duplicated`);
        } else {
          seenErrorIds.add(errorId);
        }
      }
      const ownsOrdinaryInterruptionErrors =
        attempt.state === "INTERRUPTED" && attempt.interruptionOrigin === "ORDINARY";
      if (!ownsOrdinaryInterruptionErrors && attempt.errorIds.length !== 0) {
        errors.push(
          `Only an ordinary INTERRUPTED Attempt may retain terminal interruption Errors`,
        );
      }
      if (ownsOrdinaryInterruptionErrors && attempt.errorIds.length > 1) {
        errors.push(
          `v0.1 ordinary interruption ${attempt.attemptId} may retain at most one terminal Error`,
        );
      }
    }
    if (attempt.recoverySafetyProofId !== null) {
      if (
        typeof attempt.recoverySafetyProofId !== "string" ||
        attempt.recoverySafetyProofId.length === 0
      ) {
        errors.push(`Recovery safety proof for ${attempt.attemptId} needs a non-empty identity`);
      } else if (seenRecoverySafetyProofIds.has(attempt.recoverySafetyProofId)) {
        errors.push(
          `Recovery safety proof identity ${attempt.recoverySafetyProofId} is duplicated`,
        );
      } else {
        seenRecoverySafetyProofIds.add(attempt.recoverySafetyProofId);
      }
    }
    if (attempt.terminalEffectQuiescenceProofId !== null) {
      if (
        typeof attempt.terminalEffectQuiescenceProofId !== "string" ||
        attempt.terminalEffectQuiescenceProofId.length === 0
      ) {
        errors.push(
          `Policy terminalization proof for ${attempt.attemptId} needs a non-empty identity`,
        );
      } else if (
        seenEffectQuiescenceProofIds.has(attempt.terminalEffectQuiescenceProofId)
      ) {
        errors.push(
          `Policy terminalization proof identity ${attempt.terminalEffectQuiescenceProofId} is duplicated`,
        );
      } else {
        seenEffectQuiescenceProofIds.add(attempt.terminalEffectQuiescenceProofId);
      }
    }
    if (![null, "EXECUTOR", "VERIFICATION"].includes(attempt.unknownStopTarget)) {
      errors.push(`Attempt ${attempt.attemptId} has an unknown stop target`);
    }
    if (
      ![null, verificationStopUnknownWitness].includes(
        attempt.verificationStopUnknownProvenance,
      )
    ) {
      errors.push(`Attempt ${attempt.attemptId} has unknown verifier-stop provenance`);
    }
    if (!dispatchProvenanceValues.has(attempt.executorDispatchProvenance)) {
      errors.push(`Attempt ${attempt.attemptId} has unknown Executor dispatch provenance`);
    }
    if (attempt.state === "STARTED" && attempt.executorDispatchProvenance !== null) {
      errors.push(`STARTED Attempt ${attempt.attemptId} cannot claim resolved Executor dispatch provenance`);
    }
    if (
      attempt.state === "EXECUTING" &&
      attempt.executorDispatchProvenance !== "START_ACKNOWLEDGED"
    ) {
      errors.push(`EXECUTING Attempt ${attempt.attemptId} needs acknowledged Executor dispatch provenance`);
    }
    if (attempt.candidateId && attempt.executorDispatchProvenance === null) {
      errors.push(`Candidate-bearing Attempt ${attempt.attemptId} needs Executor dispatch provenance`);
    }
    if (
      attempt.executorDispatchProvenance === "DISPATCHED_WITHOUT_START_ACK" &&
      !attempt.candidateId
    ) {
      errors.push(
        `Unacknowledged completed dispatch ${attempt.attemptId} needs its stable Candidate`,
      );
    }
    if (
      attempt.executorDispatchProvenance === "DISPATCHED_BEFORE_CANCEL" &&
      !run.cancelRequested
    ) {
      errors.push(
        `Pre-cancel dispatch provenance ${attempt.attemptId} needs the retained cancellation request`,
      );
    }
    if (["STARTED", "EXECUTING", "VERIFYING"].includes(attempt.state) && attempt.verdict) {
      errors.push(`Active Attempt ${attempt.attemptId} cannot already have a Verdict`);
    }
    if (["STARTED", "EXECUTING", "VERIFYING"].includes(attempt.state)) {
      if (
        attempt.terminalFromState !== null ||
        attempt.interruptionOrigin ||
        attempt.recoveryDispositionAtInterruption !== null ||
        attempt.recoverySafetyProofId !== null ||
        attempt.unknownStopTarget !== null ||
        attempt.verificationStopUnknownProvenance !== null ||
        attempt.terminalEffectQuiescenceProofId !== null
      ) {
        errors.push(`Active Attempt ${attempt.attemptId} cannot have terminal history`);
      }
    }
    if (["STARTED", "EXECUTING"].includes(attempt.state) && attempt.candidateId) {
      errors.push(`${attempt.state} Attempt ${attempt.attemptId} cannot already have a stable Candidate`);
    }
    if (attempt.state === "VERIFYING" && !attempt.candidateId) {
      errors.push(`VERIFYING Attempt ${attempt.attemptId} needs its stable Candidate`);
    }
    if (attempt.state === "FINISHED") {
      if (!attempt.verdict || !["PASSED", "FAILED", "POLICY_BLOCKED"].includes(attempt.verdict.value)) {
        errors.push(`FINISHED Attempt ${attempt.attemptId} needs a conclusive or Policy Verdict`);
      }
      if (["PASSED", "FAILED"].includes(attempt.verdict?.value) && !attempt.candidateId) {
        errors.push(`${attempt.verdict.value} Attempt ${attempt.attemptId} needs its Candidate`);
      }
      if (
        ["PASSED", "FAILED"].includes(attempt.verdict?.value) &&
        attempt.terminalFromState !== "VERIFYING"
      ) {
        errors.push(`${attempt.verdict.value} Attempt ${attempt.attemptId} must finish from VERIFYING`);
      }
      if (
        attempt.verdict?.value === "POLICY_BLOCKED" &&
        !["STARTED", "EXECUTING", "VERIFYING"].includes(attempt.terminalFromState)
      ) {
        errors.push(`POLICY_BLOCKED Attempt ${attempt.attemptId} needs its blocked execution phase`);
      }
      if (
        attempt.verdict?.value === "POLICY_BLOCKED" &&
        !attempt.terminalEffectQuiescenceProofId
      ) {
        errors.push(
          `POLICY_BLOCKED Attempt ${attempt.attemptId} needs its effect-quiescence proof`,
        );
      }
    }
    if (
      !(attempt.state === "FINISHED" && attempt.verdict?.value === "POLICY_BLOCKED") &&
      attempt.terminalEffectQuiescenceProofId !== null
    ) {
      errors.push(
        `Only a POLICY_BLOCKED FINISHED Attempt may retain a Policy terminalization proof`,
      );
    }
    if (attempt.state === "INTERRUPTED") {
      if (attempt.verdict?.value !== "INCONCLUSIVE") {
        errors.push(`INTERRUPTED Attempt ${attempt.attemptId} needs an INCONCLUSIVE Verdict`);
      }
      if (!new Set(["ORDINARY", "CANCEL_STOP_UNKNOWN"]).has(attempt.interruptionOrigin)) {
        errors.push(`INTERRUPTED Attempt ${attempt.attemptId} needs one known interruption origin`);
      } else if (attempt.interruptionOrigin === "ORDINARY") {
        if (attempt.interruptionCancelRequestId) {
          errors.push(`Ordinary INTERRUPTED Attempt ${attempt.attemptId} cannot claim cancellation provenance`);
        }
        if (
          attempt.unknownStopTarget !== null ||
          attempt.verificationStopUnknownProvenance !== null
        ) {
          errors.push(
            `Ordinary INTERRUPTED Attempt ${attempt.attemptId} cannot claim unknown-stop provenance`,
          );
        }
      } else if (
        !run.cancelRequested ||
        attempt.interruptionCancelRequestId !== run.cancelRequestId ||
        attempt.executorDispatchProvenance === null ||
        attempt.recoveryDispositionAtInterruption !== "RECONCILIATION_REQUIRED" ||
        attempt.recoverySafetyProofId !== null
      ) {
        errors.push(
          `CANCEL_STOP_UNKNOWN Attempt ${attempt.attemptId} needs matching cancellation, retained Executor dispatch provenance, reconciliation-required disposition, and no Recovery safety proof`,
        );
      }
      if (attempt.interruptionOrigin === "CANCEL_STOP_UNKNOWN") {
        if (
          ["STARTED", "EXECUTING"].includes(attempt.terminalFromState) &&
          (
            attempt.unknownStopTarget !== "EXECUTOR" ||
            attempt.verificationStopUnknownProvenance !== null
          )
        ) {
          errors.push(
            `Executor-phase unknown stop ${attempt.attemptId} needs exact EXECUTOR target provenance`,
          );
        }
        if (
          attempt.terminalFromState === "VERIFYING" &&
          (
            attempt.unknownStopTarget !== "VERIFICATION" ||
            attempt.verificationStopUnknownProvenance !==
              verificationStopUnknownWitness
          )
        ) {
          errors.push(
            `VERIFYING unknown stop ${attempt.attemptId} needs exact pre-cancel effect-capable verifier provenance`,
          );
        }
      }
      if (!["STARTED", "EXECUTING", "VERIFYING"].includes(attempt.terminalFromState)) {
        errors.push(`INTERRUPTED Attempt ${attempt.attemptId} needs its interruption phase`);
      }
      if (
        !["RECONCILIATION_REQUIRED", "SAFE_TO_CREATE_REPAIR"].includes(
          attempt.recoveryDispositionAtInterruption,
        )
      ) {
        errors.push(`INTERRUPTED Attempt ${attempt.attemptId} needs its interruption-time recovery disposition`);
      }
      if (
        attempt.recoveryDispositionAtInterruption === "SAFE_TO_CREATE_REPAIR" &&
        !attempt.recoverySafetyProofId
      ) {
        errors.push(
          `SAFE_TO_CREATE_REPAIR Attempt ${attempt.attemptId} needs its Recovery safety proof`,
        );
      }
      if (
        attempt.recoveryDispositionAtInterruption === "RECONCILIATION_REQUIRED" &&
        attempt.recoverySafetyProofId &&
        run.attemptIds.indexOf(attempt.attemptId) + 1 >= run.maxAttempts
      ) {
        errors.push(
          `Post-interruption Recovery safety proof for ${attempt.attemptId} requires quota that existed when it was appended`,
        );
      }
      if (
        attempt.recoveryDispositionAtInterruption === "RECONCILIATION_REQUIRED" &&
        attempt.recoverySafetyProofId &&
        run.cancelRequested &&
        currentAttempt(state, run)?.attemptId === attempt.attemptId
      ) {
        errors.push(
          `Post-interruption Recovery safety proof for ${attempt.attemptId} cannot appear behind its Run cancellation fence`,
        );
      }
      if (
        attempt.interruptionOrigin === "CANCEL_STOP_UNKNOWN" &&
        currentAttempt(state, run)?.attemptId !== attempt.attemptId
      ) {
        errors.push(
          `CANCEL_STOP_UNKNOWN Attempt ${attempt.attemptId} must remain the final Attempt`,
        );
      }
    } else if (
      attempt.interruptionOrigin ||
      attempt.interruptionCancelRequestId ||
      attempt.recoveryDispositionAtInterruption !== null ||
      attempt.recoverySafetyProofId !== null ||
      attempt.unknownStopTarget !== null ||
      attempt.verificationStopUnknownProvenance !== null
    ) {
      errors.push(`Only INTERRUPTED Attempt ${attempt.attemptId} may retain interruption history`);
    }
    if (attempt.state === "CANCELLED") {
      if (attempt.verdict) {
        errors.push(`CANCELLED Attempt ${attempt.attemptId} cannot have a Verdict`);
      }
      if (!["STARTED", "EXECUTING", "VERIFYING"].includes(attempt.terminalFromState)) {
        errors.push(`CANCELLED Attempt ${attempt.attemptId} needs its cancellation phase`);
      }
    }
    if (terminalAttemptStates.has(attempt.state)) {
      if (attempt.terminalFromState === "VERIFYING" && !attempt.candidateId) {
        errors.push(`${attempt.state} Attempt ${attempt.attemptId} from VERIFYING must retain its Candidate`);
      }
    }
    if (
      ["STARTED", "EXECUTING"].includes(attempt.terminalFromState) &&
      attempt.candidateId
    ) {
      errors.push(`${attempt.state} Attempt ${attempt.attemptId} before VERIFYING cannot have a Candidate`);
    }
    if (
      attempt.terminalFromState === "EXECUTING" &&
      attempt.executorDispatchProvenance !== "START_ACKNOWLEDGED"
    ) {
      errors.push(
        `Attempt ${attempt.attemptId} terminal from EXECUTING needs acknowledged Executor dispatch provenance`,
      );
    }
    if (
      attempt.terminalFromState === "STARTED" &&
      attempt.executorDispatchProvenance === "START_ACKNOWLEDGED"
    ) {
      errors.push(
        `Attempt ${attempt.attemptId} terminal from STARTED cannot retain acknowledged Executor-start provenance`,
      );
    }
    if (attempt.kind === "INITIAL") {
      if (attempt.parentAttemptId || attempt.triggeringVerdictId || attempt.triggeringErrorId) {
        errors.push(`Initial Attempt ${attempt.attemptId} cannot have Repair lineage`);
      }
      if (run.attemptIds[0] !== attempt.attemptId) {
        errors.push(`Initial Attempt ${attempt.attemptId} must be first`);
      }
    } else if (attempt.kind === "REPAIR") {
      const index = run.attemptIds.indexOf(attempt.attemptId);
      const parent = state.attempts[attempt.parentAttemptId];
      if (!parent || parent.attemptId !== run.attemptIds[index - 1]) {
        errors.push(`Repair Attempt ${attempt.attemptId} needs its immediate same-Run parent`);
      } else {
        const triggerCount = Number(Boolean(attempt.triggeringVerdictId)) +
          Number(Boolean(attempt.triggeringErrorId));
        if (triggerCount !== 1) {
          errors.push(`Repair Attempt ${attempt.attemptId} needs exactly one parent-owned trigger`);
        } else if (parent.verdict?.value === "FAILED") {
          if (attempt.triggeringVerdictId !== parent.verdict.id) {
            errors.push(`FAILED Repair ${attempt.attemptId} must cite its parent's FAILED Verdict`);
          }
        } else if (parent.verdict?.value === "INCONCLUSIVE") {
          const correctVerdict = attempt.triggeringVerdictId === parent.verdict.id;
          const correctError =
            Array.isArray(parent.errorIds) &&
            parent.errorIds.includes(attempt.triggeringErrorId);
          if (!correctVerdict && !correctError) {
            errors.push(`Recovery Repair ${attempt.attemptId} needs its parent's Verdict or Error`);
          }
          if (
            parent.interruptionOrigin !== "ORDINARY" ||
            !parent.recoverySafetyProofId
          ) {
            errors.push(
              `Recovery Repair ${attempt.attemptId} needs its ordinary parent's retained Recovery safety proof`,
            );
          }
        } else {
          errors.push(`Repair Attempt ${attempt.attemptId} cannot follow ${parent.verdict?.value ?? "no Verdict"}`);
        }
      }
    } else {
      errors.push(`Attempt ${attempt.attemptId} has an unknown kind`);
    }
  }

  return errors;
}

function applyOperation(state, step) {
  const priorErrors = validateState(state);
  if (priorErrors.length > 0) {
    throw new Error(`invalid prior state: ${priorErrors.join(" | ")}`);
  }
  const next = structuredClone(state);
  performOperation(next, step);
  const errors = validateState(next);
  if (errors.length > 0) throw new Error(errors.join(" | "));
  return next;
}

function runSteps(taskIds, steps) {
  let state = emptyState(taskIds);
  for (const step of steps) state = applyOperation(state, step);
  return state;
}

function lifecycleChanges(before, after) {
  const definitions = [
    ["CONTRACT_VERSION", "contracts"],
    ["RUN", "runs"],
    ["ATTEMPT", "attempts"],
  ];
  const changes = [];
  for (const [objectType, collectionName] of definitions) {
    const ids = new Set([
      ...Object.keys(before[collectionName]),
      ...Object.keys(after[collectionName]),
    ]);
    for (const id of ids) {
      const from = before[collectionName][id]?.state ?? "NONE";
      const to = after[collectionName][id]?.state ?? "NONE";
      if (from !== to) changes.push({ objectType, id, from, to });
    }
  }
  return changes;
}

function assertExpectations(state, expected, name) {
  for (const [contractId, value] of Object.entries(expected.contractStates ?? {})) {
    assert.equal(state.contracts[contractId]?.state, value, `${name}: ${contractId}`);
  }
  for (const [contractId, value] of Object.entries(expected.contractContentHashes ?? {})) {
    assert.equal(state.contracts[contractId]?.contentHash, value, `${name}: ${contractId} content`);
  }
  for (const [contractId, value] of Object.entries(expected.contractMaxAttempts ?? {})) {
    assert.equal(state.contracts[contractId]?.maxAttempts, value, `${name}: ${contractId} maxAttempts`);
  }
  for (const [runId, value] of Object.entries(expected.runStates ?? {})) {
    assert.equal(state.runs[runId]?.state, value, `${name}: ${runId}`);
  }
  for (const [attemptId, value] of Object.entries(expected.attemptStates ?? {})) {
    assert.equal(state.attempts[attemptId]?.state, value, `${name}: ${attemptId}`);
  }
  for (const [runId, value] of Object.entries(expected.runOutcomes ?? {})) {
    assert.equal(state.runs[runId]?.outcome?.value, value, `${name}: ${runId} outcome`);
  }
  for (const [runId, value] of Object.entries(expected.attemptCounts ?? {})) {
    assert.equal(state.runs[runId]?.attemptIds.length, value, `${name}: ${runId} attempts`);
  }
  for (const [runId, contractId] of Object.entries(expected.runBindings ?? {})) {
    assert.equal(state.runs[runId]?.contractId, contractId, `${name}: ${runId} binding`);
  }
  for (const [runId, value] of Object.entries(expected.runMaxAttempts ?? {})) {
    assert.equal(state.runs[runId]?.maxAttempts, value, `${name}: ${runId} maxAttempts`);
  }
}

test("the machine inventory is closed and terminal states have no outgoing transitions", () => {
  for (const [objectType, machine] of Object.entries(fixtures.machines)) {
    const states = new Set(machine.states);
    assert.equal(states.size, machine.states.length, `${objectType} has duplicate states`);
    for (const transition of machine.transitions) {
      assert.ok(
        transition.from === "NONE" || states.has(transition.from),
        `${objectType} has unknown source ${transition.from}`,
      );
      assert.ok(states.has(transition.to), `${objectType} has unknown target ${transition.to}`);
    }
    for (const terminalState of machine.terminalStates) {
      assert.ok(states.has(terminalState), `${objectType} has unknown terminal state`);
      assert.equal(
        machine.transitions.some((transition) => transition.from === terminalState),
        false,
        `${objectType} terminal state ${terminalState} has an outgoing transition`,
      );
    }
  }
});

test("all declared legal traces satisfy invariants after every operation", () => {
  for (const scenario of fixtures.validScenarios) {
    const state = runSteps(scenario.tasks, scenario.steps);
    assert.deepEqual(validateState(state), [], scenario.name);
    assertExpectations(state, scenario.expect, scenario.name);
  }
});

test("every observed lifecycle change is declared by the machine allowlist", () => {
  const statePreserving = new Set(
    fixtures.statePreservingFacts.map((fact) => fact.operation),
  );
  for (const scenario of fixtures.validScenarios) {
    let state = emptyState(scenario.tasks);
    for (const step of scenario.steps) {
      const next = applyOperation(state, step);
      const changes = lifecycleChanges(state, next);
      if (changes.length === 0) {
        assert.ok(
          statePreserving.has(step.op),
          `${scenario.name}: ${step.op} changed no lifecycle and is not declared state-preserving`,
        );
      }
      const matchedTransitions = [];
      for (const change of changes) {
        const declared = fixtures.machines[change.objectType].transitions.find(
          (transition) =>
            transition.operation === step.op &&
            transition.from === change.from &&
            transition.to === change.to,
        );
        assert.ok(
          declared,
          `${scenario.name}: ${step.op} caused undeclared ${change.objectType} ${change.from}->${change.to}`,
        );
        matchedTransitions.push(declared);
      }
      if (changes.length > 1) {
        const bundles = new Set(matchedTransitions.map((transition) => transition.bundle));
        assert.equal(
          bundles.size,
          1,
          `${scenario.name}: ${step.op} lifecycle changes must share one atomic bundle`,
        );
        assert.notEqual(
          matchedTransitions[0].bundle,
          undefined,
          `${scenario.name}: ${step.op} multi-object lifecycle change needs an atomic bundle`,
        );
      }
      state = next;
    }
  }
});

test("all declared illegal traces fail atomically for the expected reason", () => {
  for (const scenario of fixtures.invalidScenarios) {
    let state = emptyState(scenario.tasks);
    let caught;
    for (const step of scenario.steps) {
      const before = structuredClone(state);
      try {
        state = applyOperation(state, step);
      } catch (error) {
        caught = error;
        assert.deepEqual(state, before, `${scenario.name}: rejected transition mutated prior state`);
        break;
      }
    }
    assert.ok(caught, `${scenario.name} unexpectedly passed`);
    assert.match(caught.message, new RegExp(scenario.expectedError, "i"), scenario.name);
  }
});

test("every operation rejects undeclared source states without mutating the prior snapshot", () => {
  const collectionByObject = {
    CONTRACT_VERSION: "contracts",
    RUN: "runs",
    ATTEMPT: "attempts",
  };
  const transitionWitnesses = new Map();
  const statePreservingWitnesses = [];

  for (const scenario of fixtures.validScenarios) {
    let state = emptyState(scenario.tasks);
    for (const step of scenario.steps) {
      const before = state;
      const after = applyOperation(before, step);
      const changes = lifecycleChanges(before, after);

      for (const change of changes) {
        const key = [change.objectType, step.op, change.from, change.to].join("|");
        if (!transitionWitnesses.has(key)) transitionWitnesses.set(key, {
          scenarioName: scenario.name,
          step,
          before,
          after,
          change,
        });
      }
      if (changes.length === 0) {
        statePreservingWitnesses.push({
          scenarioName: scenario.name,
          step,
          before,
          after,
        });
      }
      state = after;
    }
  }

  const missingEdges = [];
  for (const [objectType, machine] of Object.entries(fixtures.machines)) {
    for (const transition of machine.transitions) {
      const key = [
        objectType,
        transition.operation,
        transition.from,
        transition.to,
      ].join("|");
      if (!transitionWitnesses.has(key)) missingEdges.push(key);
    }
  }
  assert.deepEqual(
    missingEdges,
    [],
    `every declared transition edge needs a legal execution witness; missing ${missingEdges.join(", ")}`,
  );

  for (const witness of transitionWitnesses.values()) {
    const { objectType, id, to } = witness.change;
    const machine = fixtures.machines[objectType];
    const collectionName = collectionByObject[objectType];
    const allowedSources = new Set(
      machine.transitions
        .filter(
          (transition) =>
            transition.operation === witness.step.op && transition.to === to,
        )
        .map((transition) => transition.from),
    );

    for (const source of ["NONE", ...machine.states]) {
      if (allowedSources.has(source)) continue;

      const altered = structuredClone(witness.before);
      if (source === "NONE") {
        delete altered[collectionName][id];
      } else {
        const subject = altered[collectionName][id] ??
          structuredClone(witness.after[collectionName][id]);
        subject.state = source;
        altered[collectionName][id] = subject;
      }
      const snapshot = structuredClone(altered);

      assert.throws(
        () => applyOperation(altered, witness.step),
        undefined,
        `${witness.scenarioName}: ${witness.step.op} accepted undeclared ${objectType} source ${source} for target ${to}`,
      );
      assert.deepEqual(
        altered,
        snapshot,
        `${witness.scenarioName}: rejected ${objectType} ${source}->${to} mutated the prior snapshot`,
      );
    }
  }

  for (const fact of fixtures.statePreservingFacts) {
    const collectionName = collectionByObject[fact.object];
    const idField = fact.object === "RUN" ? "runId" :
      fact.object === "ATTEMPT" ? "attemptId" : "contractId";
    const machine = fixtures.machines[fact.object];
    const allowedSources = new Set(fact.states);
    const witnessesByState = new Map();
    for (const witness of statePreservingWitnesses) {
      if (witness.step.op !== fact.operation) continue;
      const subjectId = witness.step[idField];
      const source = witness.before[collectionName][subjectId]?.state;
      if (source && !witnessesByState.has(source)) {
        witnessesByState.set(source, { ...witness, subjectId });
      }
    }

    assert.deepEqual(
      [...allowedSources].filter((source) => !witnessesByState.has(source)),
      [],
      `${fact.operation} needs a legal state-preserving witness for every declared source`,
    );

    for (const [legalSource, witness] of witnessesByState) {
      if (!allowedSources.has(legalSource)) continue;
      assert.equal(
        witness.after[collectionName][witness.subjectId].state,
        legalSource,
        `${fact.operation} must preserve ${fact.object} lifecycle in ${legalSource}`,
      );

      for (const source of ["NONE", ...machine.states]) {
        if (allowedSources.has(source)) continue;

        const altered = structuredClone(witness.before);
        if (source === "NONE") {
          delete altered[collectionName][witness.subjectId];
        } else {
          altered[collectionName][witness.subjectId].state = source;
        }
        const snapshot = structuredClone(altered);

        assert.throws(
          () => applyOperation(altered, witness.step),
          undefined,
          `${witness.scenarioName}: ${fact.operation} accepted undeclared ${fact.object} source ${source}`,
        );
        assert.deepEqual(
          altered,
          snapshot,
          `${witness.scenarioName}: rejected state-preserving ${fact.operation} mutated the prior snapshot`,
        );
      }
    }
  }
});

function stateAfter(scenarioName, stepCount) {
  const scenario = fixtures.validScenarios.find((item) => item.name === scenarioName);
  assert.ok(scenario, `missing scenario ${scenarioName}`);
  return runSteps(scenario.tasks, scenario.steps.slice(0, stepCount));
}

test("same-state guard attacks are rejected atomically", () => {
  const cases = [
    {
      name: "AWAITING_APPROVAL Contract cannot create a Run",
      baseline: () => stateAfter("contract-replacement-preserves-an-existing-run", 10),
      step: { op: "CREATE_RUN", runId: "run-from-waiting", contractId: "contract-v2" },
      expected: /currently FROZEN/i,
    },
    {
      name: "cross-Task successor cannot replace a Contract",
      baseline: () => {
        const state = stateAfter("contract-replacement-preserves-an-existing-run", 10);
        state.tasks["task-other"] = { taskId: "task-other" };
        state.contracts["contract-v2"].taskId = "task-other";
        return state;
      },
      step: {
        op: "APPROVE_FREEZE_AND_SUPERSEDE",
        contractId: "contract-v2",
        predecessorId: "contract-v1",
      },
      expected: /same Task/i,
    },
    {
      name: "non-later successor cannot replace a Contract",
      baseline: () => {
        const state = stateAfter("contract-replacement-preserves-an-existing-run", 10);
        state.contracts["contract-v1"].order = 2;
        state.contracts["contract-v2"].order = 1;
        return state;
      },
      step: {
        op: "APPROVE_FREEZE_AND_SUPERSEDE",
        contractId: "contract-v2",
        predecessorId: "contract-v1",
      },
      expected: /later than its predecessor/i,
    },
    {
      name: "a Contract cannot replace itself",
      baseline: () => stateAfter("contract-replacement-preserves-an-existing-run", 10),
      step: {
        op: "APPROVE_FREEZE_AND_SUPERSEDE",
        contractId: "contract-v1",
        predecessorId: "contract-v1",
      },
      expected: /AWAITING_APPROVAL|different Contract Version/i,
    },
    {
      name: "FROZEN Contract cannot be edited",
      baseline: () => stateAfter("contract-replacement-preserves-an-existing-run", 3),
      step: {
        op: "EDIT_CONTRACT_CONTENT",
        contractId: "contract-v1",
        contentHash: "forbidden-frozen-edit",
        maxAttempts: 1,
      },
      expected: /DRAFT or CLARIFYING/i,
    },
    {
      name: "POLICY_BLOCKED Run cannot create Repair",
      baseline: () => runSteps(
        fixtures.validScenarios.find((item) => item.name === "in-attempt-permanent-policy-block-uses-verdict").tasks,
        fixtures.validScenarios.find((item) => item.name === "in-attempt-permanent-policy-block-uses-verdict").steps,
      ),
      step: {
        op: "START_REPAIR_ATTEMPT",
        runId: "run-policy-active",
        attemptId: "attempt-after-policy",
      },
      expected: /AWAITING_REPAIR/i,
    },
    {
      name: "CANCELLED Run cannot create Repair",
      baseline: () => runSteps(
        fixtures.validScenarios.find((item) => item.name === "confirmed-cancellation-cancels-only-the-active-attempt").tasks,
        fixtures.validScenarios.find((item) => item.name === "confirmed-cancellation-cancels-only-the-active-attempt").steps,
      ),
      step: {
        op: "START_REPAIR_ATTEMPT",
        runId: "run-cancel",
        attemptId: "attempt-after-cancel",
      },
      expected: /AWAITING_REPAIR/i,
    },
    {
      name: "exhausted FAILED Run cannot create Repair",
      baseline: () => runSteps(
        fixtures.validScenarios.find((item) => item.name === "one-attempt-quota-makes-failure-final").tasks,
        fixtures.validScenarios.find((item) => item.name === "one-attempt-quota-makes-failure-final").steps,
      ),
      step: {
        op: "START_REPAIR_ATTEMPT",
        runId: "run-quota",
        attemptId: "attempt-over-quota",
      },
      expected: /AWAITING_REPAIR/i,
    },
    {
      name: "ordinary Attempt interruption cannot receive late cancellation",
      baseline: () => {
        const state = stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8);
        state.runs["run-recovery"].cancelRequested = true;
        state.runs["run-recovery"].cancelRequestId = "cancel-unrelated-to-interruption";
        return state;
      },
      step: {
        op: "CONFIRM_CANCEL",
        runId: "run-recovery",
        cancelRequestId: "cancel-unrelated-to-interruption",
        terminalEventId: "event-unrelated-late-cancel",
      },
      expected: /only a Preflight abandonment or matching late stop confirmation/i,
    },
    {
      name: "STARTED Executor unknown stop cannot claim verifier provenance",
      baseline: () => stateAfter(
        "unknown-stop-without-executor-start-ack-ends-inconclusive",
        7,
      ),
      step: {
        op: "STOP_RESULT_UNKNOWN",
        runId: "run-stop-unknown-started",
        verdictId: "verdict-reject-verifier-on-started",
        dispatchProvenance: "DISPATCHED_BEFORE_CANCEL",
        verificationStopProvenance: verificationStopUnknownWitness,
      },
      expected: /Executor unknown stop cannot claim verifier-stop provenance/i,
    },
    {
      name: "EXECUTING unknown stop cannot replace acknowledged dispatch provenance",
      baseline: () => stateAfter(
        "unknown-cancel-stop-can-later-receive-matching-confirmation",
        8,
      ),
      step: {
        op: "STOP_RESULT_UNKNOWN",
        runId: "run-cancel-unknown",
        verdictId: "verdict-reject-dispatch-on-executing",
        dispatchProvenance: "DISPATCHED_BEFORE_CANCEL",
      },
      expected: /cannot replace dispatch provenance/i,
    },
    {
      name: "EXECUTING Executor unknown stop cannot claim verifier provenance",
      baseline: () => stateAfter(
        "unknown-cancel-stop-can-later-receive-matching-confirmation",
        8,
      ),
      step: {
        op: "STOP_RESULT_UNKNOWN",
        runId: "run-cancel-unknown",
        verdictId: "verdict-reject-verifier-on-executing",
        verificationStopProvenance: verificationStopUnknownWitness,
      },
      expected: /Executor unknown stop cannot claim verifier-stop provenance/i,
    },
    {
      name: "VERIFYING unknown stop cannot claim active Executor provenance",
      baseline: () => stateAfter(
        "unknown-stop-during-verification-ends-inconclusive",
        9,
      ),
      step: {
        op: "STOP_RESULT_UNKNOWN",
        runId: "run-stop-unknown-verifying",
        verdictId: "verdict-reject-executor-on-verifying",
        dispatchProvenance: "DISPATCHED_BEFORE_CANCEL",
        verificationStopProvenance: verificationStopUnknownWitness,
      },
      expected: /cannot claim active Executor dispatch provenance/i,
    },
  ];

  for (const item of cases) {
    const state = item.baseline();
    assert.deepEqual(validateState(state), [], `${item.name}: baseline`);
    const snapshot = structuredClone(state);
    assert.throws(() => applyOperation(state, item.step), item.expected, item.name);
    assert.deepEqual(state, snapshot, `${item.name}: rejection mutated the prior snapshot`);
  }
});

test("lifecycle-preserving operations change only their declared facts", () => {
  {
    const before = stateAfter("confirmed-cancellation-cancels-only-the-active-attempt", 7);
    const after = applyOperation(before, {
      op: "REQUEST_CANCEL",
      runId: "run-cancel",
      cancelRequestId: "cancel-fact-only",
    });
    const expected = structuredClone(before);
    expected.runs["run-cancel"].cancelRequested = true;
    expected.runs["run-cancel"].cancelRequestId = "cancel-fact-only";
    assert.deepEqual(after, expected, "REQUEST_CANCEL changed more than its cancellation fact");
  }

  {
    const before = stateAfter("approval-changes-return-to-editable-draft", 1);
    const after = applyOperation(before, {
      op: "EDIT_CONTRACT_CONTENT",
      contractId: "contract-changes",
      contentHash: "hash-edit-fact-only",
      maxAttempts: 1,
    });
    const expected = structuredClone(before);
    expected.contracts["contract-changes"].contentHash = "hash-edit-fact-only";
    expected.contracts["contract-changes"].maxAttempts = 1;
    assert.deepEqual(after, expected, "EDIT_CONTRACT_CONTENT changed lifecycle or approval facts");
  }

  {
    const before = stateAfter("preflight-interruption-retries-without-an-attempt", 5);
    const after = applyOperation(before, {
      op: "PREFLIGHT_CHECK_FAILED",
      runId: "run-preflight-retry",
      diagnosticId: "diagnostic-fact-only",
    });
    const expected = structuredClone(before);
    expected.runs["run-preflight-retry"].diagnosticIds.push("diagnostic-fact-only");
    assert.deepEqual(after, expected, "PREFLIGHT_CHECK_FAILED changed more than diagnostics");
  }

  {
    const before = stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8);
    const after = applyOperation(before, {
      op: "CONFIRM_RECOVERY_SAFETY",
      attemptId: "attempt-interrupted",
      recoverySafety: recoverySafetyWitness,
      recoverySafetyProofId: "recovery-safety-fact-only",
    });
    const expected = structuredClone(before);
    expected.attempts["attempt-interrupted"].recoverySafetyProofId =
      "recovery-safety-fact-only";
    assert.deepEqual(
      after,
      expected,
      "CONFIRM_RECOVERY_SAFETY changed more than its appended proof fact",
    );
  }
});

test("accepted operations never erase or rewrite existing Attempt history facts", () => {
  const immutableFields = [
    "attemptId",
    "runId",
    "kind",
    "parentAttemptId",
    "triggeringVerdictId",
    "triggeringErrorId",
  ];
  const stickyFields = [
    "candidateId",
    "executorDispatchProvenance",
    "terminalFromState",
    "interruptionOrigin",
    "recoveryDispositionAtInterruption",
    "recoverySafetyProofId",
    "unknownStopTarget",
    "verificationStopUnknownProvenance",
    "terminalEffectQuiescenceProofId",
    "interruptionCancelRequestId",
    "verdict",
  ];

  for (const scenario of fixtures.validScenarios) {
    let state = emptyState(scenario.tasks);
    for (const step of scenario.steps) {
      const before = state;
      const after = applyOperation(before, step);
      for (const [attemptId, priorAttempt] of Object.entries(before.attempts)) {
        const nextAttempt = after.attempts[attemptId];
        assert.ok(nextAttempt, `${scenario.name}: ${step.op} erased Attempt ${attemptId}`);
        for (const field of immutableFields) {
          assert.deepEqual(
            nextAttempt[field],
            priorAttempt[field],
            `${scenario.name}: ${step.op} rewrote ${attemptId}.${field}`,
          );
        }
        for (const field of stickyFields) {
          if (priorAttempt[field] !== null) {
            assert.deepEqual(
              nextAttempt[field],
              priorAttempt[field],
              `${scenario.name}: ${step.op} erased or rewrote ${attemptId}.${field}`,
            );
          }
        }
        assert.deepEqual(
          nextAttempt.errorIds.slice(0, priorAttempt.errorIds.length),
          priorAttempt.errorIds,
          `${scenario.name}: ${step.op} erased ${attemptId} execution errors`,
        );
      }
      state = after;
    }
  }
});

const invariantMutations = [
  {
    name: "Contract Version cannot lose its owning Task",
    baseline: () => stateAfter("contract-replacement-preserves-an-existing-run", 3),
    mutate(state) { delete state.tasks["task-contract"]; },
    expected: "needs exactly one owning Task",
  },
  {
    name: "QUEUED Run cannot contain a diagnostic from a Preflight that never started",
    baseline: () => stateAfter("contract-replacement-preserves-an-existing-run", 4),
    mutate(state) {
      state.runs["run-v1"].diagnosticIds.push(
        "forged-preflight-diagnostic-before-preflight",
      );
    },
    expected: "cannot contain Preflight diagnostics",
  },
  {
    name: "Contract content identity cannot be synchronously emptied",
    baseline: () => stateAfter("contract-replacement-preserves-an-existing-run", 4),
    mutate(state) {
      state.contracts["contract-v1"].contentHash = "";
      state.contracts["contract-v1"].approvedContentHash = "";
      state.runs["run-v1"].boundContractHash = "";
    },
    expected: "needs a non-empty content identity",
  },
  {
    name: "Run Attempt sequence cannot repeat an identity",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) { state.runs["run-repair"].attemptIds.push("attempt-2"); },
    expected: "duplicate Attempt identities",
  },
  {
    name: "AttemptVerdict identity cannot be empty",
    baseline: () => stateAfter("failed-initial-attempt-repair-passes", 9),
    mutate(state) { state.attempts["attempt-1"].verdict.id = ""; },
    expected: "needs a non-empty identity",
  },
  {
    name: "AttemptVerdict identity must be globally unique",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) {
      state.attempts["attempt-2"].verdict.id = "verdict-1";
      state.runs["run-repair"].outcome.finalAttemptVerdictId = "verdict-1";
    },
    expected: "identity is duplicated",
  },
  {
    name: "CANCELLED Run cannot claim PASSED",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "confirmed-cancellation-cancels-only-the-active-attempt").tasks,
      fixtures.validScenarios.find((item) => item.name === "confirmed-cancellation-cancels-only-the-active-attempt").steps,
    ),
    mutate(state) { state.runs["run-cancel"].outcome.value = "PASSED"; },
    expected: "CANCELLED Run",
  },
  {
    name: "FINISHED Run cannot claim CANCELLED",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) { state.runs["run-repair"].outcome.value = "CANCELLED"; },
    expected: "FINISHED Run",
  },
  {
    name: "terminal Run cannot retain an Active Attempt",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) { state.attempts["attempt-2"].state = "EXECUTING"; },
    expected: "Terminal Run",
  },
  {
    name: "AWAITING_REPAIR cannot contain INCONCLUSIVE",
    baseline: () => stateAfter("failed-initial-attempt-repair-passes", 9),
    mutate(state) { state.attempts["attempt-1"].verdict.value = "INCONCLUSIVE"; },
    expected: "AWAITING_REPAIR",
  },
  {
    name: "INTERRUPTED cannot contain FAILED",
    baseline: () => stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8),
    mutate(state) { state.attempts["attempt-interrupted"].verdict.value = "FAILED"; },
    expected: "INTERRUPTED Run",
  },
  {
    name: "FINISHED Attempt cannot lose its Verdict",
    baseline: () => stateAfter("failed-initial-attempt-repair-passes", 9),
    mutate(state) { state.attempts["attempt-1"].verdict = null; },
    expected: "FINISHED Attempt",
  },
  {
    name: "VERIFYING Attempt cannot already have a Verdict",
    baseline: () => stateAfter("failed-initial-attempt-repair-passes", 8),
    mutate(state) { state.attempts["attempt-1"].verdict = { id: "too-early", value: "PASSED" }; },
    expected: "Active Attempt",
  },
  {
    name: "RunOutcome cannot cite an earlier Verdict",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) { state.runs["run-repair"].outcome.finalAttemptVerdictId = "verdict-1"; },
    expected: "final AttemptVerdict",
  },
  {
    name: "Event-based Policy block cannot have Attempts",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) {
      state.runs["run-repair"].outcome = { value: "POLICY_BLOCKED", terminalEventId: "event-forged" };
    },
    expected: "requires zero Attempts",
  },
  {
    name: "Task cannot have two current FROZEN versions",
    baseline: () => stateAfter("contract-replacement-preserves-an-existing-run", 9),
    mutate(state) {
      state.contracts["contract-v2"].state = "FROZEN";
      state.contracts["contract-v2"].approved = true;
      state.contracts["contract-v2"].approvedContentHash =
        state.contracts["contract-v2"].contentHash;
    },
    expected: "more than one current FROZEN",
  },
  {
    name: "SUPERSEDED successor cannot be a draft",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "contract-replacement-preserves-an-existing-run").tasks,
      fixtures.validScenarios.find((item) => item.name === "contract-replacement-preserves-an-existing-run").steps,
    ),
    mutate(state) {
      state.contracts["contract-v2"].state = "DRAFT";
      state.contracts["contract-v2"].approved = false;
      state.contracts["contract-v2"].approvedContentHash = null;
    },
    expected: "later same-Task frozen successor",
  },
  {
    name: "successor cannot have two direct predecessors",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "contract-replacement-preserves-an-existing-run").tasks,
      fixtures.validScenarios.find((item) => item.name === "contract-replacement-preserves-an-existing-run").steps,
    ),
    mutate(state) {
      state.contracts["contract-v0"] = {
        contractId: "contract-v0",
        taskId: "task-contract",
        order: 0,
        contentHash: "hash-v0",
        maxAttempts: 2,
        state: "SUPERSEDED",
        approved: true,
        approvedContentHash: "hash-v0",
        successorId: "contract-v2",
      };
    },
    expected: "more than one direct predecessor",
  },
  {
    name: "Contract successor chain cannot contain a cycle",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "contract-replacement-preserves-an-existing-run").tasks,
      fixtures.validScenarios.find((item) => item.name === "contract-replacement-preserves-an-existing-run").steps,
    ),
    mutate(state) {
      state.contracts["contract-v2"].state = "SUPERSEDED";
      state.contracts["contract-v2"].successorId = "contract-v1";
    },
    expected: "successor chain contains a cycle",
  },
  {
    name: "Repair cannot follow a PASSED Verdict",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) { state.attempts["attempt-1"].verdict.value = "PASSED"; },
    expected: "cannot follow PASSED",
  },
  {
    name: "Repair parent must be the immediately preceding Attempt",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) { state.attempts["attempt-2"].parentAttemptId = "attempt-2"; },
    expected: "immediate same-Run parent",
  },
  {
    name: "RunOutcome cannot have two terminal bases",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) { state.runs["run-repair"].outcome.terminalEventId = "second-basis"; },
    expected: "exactly one terminal basis",
  },
  {
    name: "CANCELLED Run must retain a cancellation request",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "confirmed-cancellation-cancels-only-the-active-attempt").tasks,
      fixtures.validScenarios.find((item) => item.name === "confirmed-cancellation-cancels-only-the-active-attempt").steps,
    ),
    mutate(state) { state.runs["run-cancel"].cancelRequested = false; },
    expected: "cancellation fact and request identity",
  },
  {
    name: "PASSED final Attempt cannot be washed into CANCELLED",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) {
      const run = state.runs["run-repair"];
      run.state = "CANCELLED";
      run.cancelRequested = true;
      run.cancelRequestId = "forged-cancel-pass";
      run.outcome = {
        value: "CANCELLED",
        terminalEventId: "forged-cancel-pass-event",
        cancelRequestId: "forged-cancel-pass",
        cancelSource: "ACTIVE_STOP_CONFIRMED",
      };
    },
    expected: "illegal final Attempt shape",
  },
  {
    name: "FAILED final Attempt cannot be washed into CANCELLED",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "one-attempt-quota-makes-failure-final").tasks,
      fixtures.validScenarios.find((item) => item.name === "one-attempt-quota-makes-failure-final").steps,
    ),
    mutate(state) {
      const run = state.runs["run-quota"];
      run.state = "CANCELLED";
      run.cancelRequested = true;
      run.cancelRequestId = "forged-cancel-fail";
      run.outcome = {
        value: "CANCELLED",
        terminalEventId: "forged-cancel-fail-event",
        cancelRequestId: "forged-cancel-fail",
        cancelSource: "ACTIVE_STOP_CONFIRMED",
      };
    },
    expected: "illegal final Attempt shape",
  },
  {
    name: "POLICY_BLOCKED final Attempt cannot be washed into CANCELLED",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "in-attempt-permanent-policy-block-uses-verdict").tasks,
      fixtures.validScenarios.find((item) => item.name === "in-attempt-permanent-policy-block-uses-verdict").steps,
    ),
    mutate(state) {
      const run = state.runs["run-policy-active"];
      run.state = "CANCELLED";
      run.cancelRequested = true;
      run.cancelRequestId = "forged-cancel-policy";
      run.outcome = {
        value: "CANCELLED",
        terminalEventId: "forged-cancel-policy-event",
        cancelRequestId: "forged-cancel-policy",
        cancelSource: "ACTIVE_STOP_CONFIRMED",
      };
    },
    expected: "illegal final Attempt shape",
  },
  {
    name: "Attempt interruption cannot masquerade as Preflight interruption",
    baseline: () => stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8),
    mutate(state) { state.runs["run-recovery"].interruptionKind = "PREFLIGHT"; },
    expected: "cannot be PREFLIGHT",
  },
  {
    name: "Preflight interruption cannot masquerade as Attempt interruption",
    baseline: () => stateAfter("preflight-interruption-retries-without-an-attempt", 7),
    mutate(state) { state.runs["run-preflight-retry"].interruptionKind = "ATTEMPT"; },
    expected: "must be PREFLIGHT",
  },
  {
    name: "Unknown-stop interruption needs matching cancellation provenance",
    baseline: () => stateAfter("unknown-cancel-stop-can-later-receive-matching-confirmation", 9),
    mutate(state) {
      state.attempts["attempt-cancel-unknown"].interruptionCancelRequestId = "unrelated-cancel";
    },
    expected: "must match its pending cancellation request",
  },
  {
    name: "Unknown-stop interruption cannot lose Executor dispatch provenance",
    baseline: () => stateAfter(
      "unknown-stop-without-executor-start-ack-ends-inconclusive",
      8,
    ),
    mutate(state) {
      state.attempts["attempt-stop-unknown-started"].executorDispatchProvenance = null;
    },
    expected: "needs retained Executor dispatch provenance",
  },
  {
    name: "FINISHED unknown-stop history cannot lose Executor dispatch provenance",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "unknown-stop-without-executor-start-ack-ends-inconclusive",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "unknown-stop-without-executor-start-ack-ends-inconclusive",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-stop-unknown-started"].executorDispatchProvenance = null;
    },
    expected: "CANCEL_STOP_UNKNOWN Attempt",
  },
  {
    name: "CANCELLED unknown-stop history cannot lose Executor dispatch provenance",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "unknown-cancel-stop-can-later-receive-matching-confirmation",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "unknown-cancel-stop-can-later-receive-matching-confirmation",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-cancel-unknown"].executorDispatchProvenance = null;
    },
    expected: "CANCEL_STOP_UNKNOWN Attempt",
  },
  {
    name: "every INTERRUPTED Attempt needs a retained origin",
    baseline: () => stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8),
    mutate(state) {
      state.attempts["attempt-interrupted"].interruptionOrigin = null;
    },
    expected: "needs one known interruption origin",
  },
  {
    name: "every INTERRUPTED Attempt needs a retained recovery disposition",
    baseline: () => stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8),
    mutate(state) {
      state.attempts["attempt-interrupted"].recoveryDispositionAtInterruption = null;
    },
    expected: "needs its interruption-time recovery disposition",
  },
  {
    name: "CANCEL_STOP_UNKNOWN can never claim safe Recovery",
    baseline: () => stateAfter(
      "unknown-stop-without-executor-start-ack-ends-inconclusive",
      8,
    ),
    mutate(state) {
      state.attempts["attempt-stop-unknown-started"].recoveryDispositionAtInterruption =
        "SAFE_TO_CREATE_REPAIR";
    },
    expected: "reconciliation-required disposition",
  },
  {
    name: "CANCEL_STOP_UNKNOWN cannot receive a Recovery safety proof",
    baseline: () => stateAfter(
      "unknown-stop-without-executor-start-ack-ends-inconclusive",
      8,
    ),
    mutate(state) {
      state.attempts["attempt-stop-unknown-started"].recoverySafetyProofId =
        "forged-unknown-stop-safety";
    },
    expected: "no Recovery safety proof",
  },
  {
    name: "an interruption declared safe at interruption cannot lose its proof",
    baseline: () => stateAfter("verifying-interruption-with-room-can-end-inconclusive", 9),
    mutate(state) {
      state.attempts["attempt-interrupt-verifying-room"].recoverySafetyProofId = null;
    },
    expected: "needs its Recovery safety proof",
  },
  {
    name: "Recovery safety proof identity cannot be empty",
    baseline: () => stateAfter("verifying-interruption-with-room-can-end-inconclusive", 9),
    mutate(state) {
      state.attempts["attempt-interrupt-verifying-room"].recoverySafetyProofId = "";
    },
    expected: "needs a non-empty identity",
  },
  {
    name: "Recovery safety proof identity must be globally unique",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "interrupted-attempt-recovers-with-a-new-repair",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "interrupted-attempt-recovers-with-a-new-repair",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-recovery"].recoverySafetyProofId =
        "recovery-safety-after-disconnect";
    },
    expected: "is duplicated",
  },
  {
    name: "an exhausted terminal interruption cannot gain a later Recovery safety proof",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "exhausted-started-interruption-finishes-inconclusive",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "exhausted-started-interruption-finishes-inconclusive",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-interrupt-started-final"].recoverySafetyProofId =
        "forged-post-terminal-proof";
    },
    expected: "requires quota that existed when it was appended",
  },
  {
    name: "a current ordinary interruption cannot gain later Recovery proof behind cancellation",
    baseline: () => {
      let state = stateAfter("confirmed-cancellation-cancels-only-the-active-attempt", 7);
      state = applyOperation(state, {
        op: "REQUEST_CANCEL",
        runId: "run-cancel",
        cancelRequestId: "cancel-before-ordinary-interruption",
      });
      return applyOperation(state, {
        op: "INTERRUPT_ATTEMPT",
        attemptId: "attempt-cancel",
        verdictId: "verdict-ordinary-after-cancel-request",
        errorId: "error-ordinary-after-cancel-request",
      });
    },
    mutate(state) {
      state.attempts["attempt-cancel"].recoverySafetyProofId =
        "forged-proof-behind-cancel-fence";
    },
    expected: "cannot appear behind its Run cancellation fence",
  },
  {
    name: "a Recovery Repair cannot outlive its parent's safety proof",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "interrupted-attempt-recovers-with-a-new-repair",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "interrupted-attempt-recovers-with-a-new-repair",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-interrupted"].recoverySafetyProofId = null;
    },
    expected: "needs its ordinary parent's retained Recovery safety proof",
  },
  {
    name: "an active Attempt cannot predeclare a recovery disposition",
    baseline: () => stateAfter("failed-initial-attempt-repair-passes", 8),
    mutate(state) {
      state.attempts["attempt-1"].recoveryDispositionAtInterruption =
        "RECONCILIATION_REQUIRED";
    },
    expected: "cannot have terminal history",
  },
  {
    name: "an interruption from EXECUTING cannot lose start acknowledgement",
    baseline: () => stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8),
    mutate(state) {
      state.attempts["attempt-interrupted"].executorDispatchProvenance = null;
    },
    expected: "terminal from EXECUTING needs acknowledged Executor dispatch provenance",
  },
  {
    name: "a cancellation from EXECUTING cannot lose start acknowledgement",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "confirmed-cancellation-cancels-only-the-active-attempt",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "confirmed-cancellation-cancels-only-the-active-attempt",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-cancel"].executorDispatchProvenance = null;
    },
    expected: "terminal from EXECUTING needs acknowledged Executor dispatch provenance",
  },
  {
    name: "EXECUTING interruption cannot be relabelled STARTED while retaining acknowledgement",
    baseline: () => stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8),
    mutate(state) {
      state.attempts["attempt-interrupted"].terminalFromState = "STARTED";
    },
    expected: "terminal from STARTED cannot retain acknowledged Executor-start provenance",
  },
  {
    name: "EXECUTING cancellation cannot be relabelled STARTED while retaining acknowledgement",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "confirmed-cancellation-cancels-only-the-active-attempt",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "confirmed-cancellation-cancels-only-the-active-attempt",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-cancel"].terminalFromState = "STARTED";
    },
    expected: "terminal from STARTED cannot retain acknowledged Executor-start provenance",
  },
  {
    name: "EXECUTING Policy block cannot be relabelled STARTED while retaining acknowledgement",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "in-attempt-permanent-policy-block-uses-verdict",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "in-attempt-permanent-policy-block-uses-verdict",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-policy-active"].terminalFromState = "STARTED";
    },
    expected: "terminal from STARTED cannot retain acknowledged Executor-start provenance",
  },
  {
    name: "POLICY_BLOCKED from STARTED cannot invent a Candidate",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "policy-block-before-executor-starts",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "policy-block-before-executor-starts",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-policy-started"].candidateId = "forged-policy-candidate";
    },
    expected: "before VERIFYING cannot have a Candidate",
  },
  {
    name: "POLICY_BLOCKED from EXECUTING cannot invent a Candidate",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "in-attempt-permanent-policy-block-uses-verdict",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "in-attempt-permanent-policy-block-uses-verdict",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-policy-active"].candidateId = "forged-policy-candidate";
    },
    expected: "before VERIFYING cannot have a Candidate",
  },
  {
    name: "FINISHED unknown-stop history cannot lose cancellation correlation",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "unknown-stop-without-executor-start-ack-ends-inconclusive",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "unknown-stop-without-executor-start-ack-ends-inconclusive",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-stop-unknown-started"].interruptionCancelRequestId = null;
    },
    expected: "CANCEL_STOP_UNKNOWN Attempt",
  },
  {
    name: "FINISHED unknown-stop history cannot lose all cancellation provenance",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "unknown-stop-without-executor-start-ack-ends-inconclusive",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "unknown-stop-without-executor-start-ack-ends-inconclusive",
      ).steps,
    ),
    mutate(state) {
      const attempt = state.attempts["attempt-stop-unknown-started"];
      attempt.interruptionCancelRequestId = null;
      attempt.executorDispatchProvenance = null;
    },
    expected: "CANCEL_STOP_UNKNOWN Attempt",
  },
  {
    name: "current unknown-stop cannot be downgraded to ordinary interruption",
    baseline: () => stateAfter(
      "unknown-stop-without-executor-start-ack-ends-inconclusive",
      8,
    ),
    mutate(state) {
      const run = state.runs["run-stop-unknown-started"];
      const attempt = state.attempts["attempt-stop-unknown-started"];
      run.interruptionKind = "ATTEMPT";
      run.interruptionCancelRequestId = null;
      attempt.interruptionCancelRequestId = null;
      attempt.executorDispatchProvenance = null;
    },
    expected: "ordinary Attempt interruption",
  },
  {
    name: "CANCEL_STOP_UNKNOWN history cannot have a later Repair Attempt",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "interrupted-attempt-recovers-with-a-new-repair",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "interrupted-attempt-recovers-with-a-new-repair",
      ).steps,
    ),
    mutate(state) {
      const run = state.runs["run-recovery"];
      const interrupted = state.attempts["attempt-interrupted"];
      run.cancelRequested = true;
      run.cancelRequestId = "cancel-forged-before-recovery";
      interrupted.interruptionOrigin = "CANCEL_STOP_UNKNOWN";
      interrupted.interruptionCancelRequestId = run.cancelRequestId;
      interrupted.executorDispatchProvenance = "START_ACKNOWLEDGED";
      state.attempts["attempt-recovery"].verdict.postCancelConvergenceSafe = true;
    },
    expected: "must remain the final Attempt",
  },
  {
    name: "Run cannot override its Frozen Contract attempt limit",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) { state.runs["run-repair"].maxAttempts = 1; },
    expected: "exact frozen Contract binding",
  },
  {
    name: "v0.1 Run attempt limit cannot exceed the product bound",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) {
      state.contracts["contract-repair"].maxAttempts = 3;
      state.runs["run-repair"].maxAttempts = 3;
    },
    expected: "invalid v0.1 maxAttempts",
  },
  {
    name: "exhausted ordinary interruption cannot remain INTERRUPTED",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "exhausted-started-interruption-finishes-inconclusive").tasks,
      fixtures.validScenarios.find((item) => item.name === "exhausted-started-interruption-finishes-inconclusive").steps,
    ),
    mutate(state) {
      const run = state.runs["run-interrupt-started-final"];
      run.state = "INTERRUPTED";
      run.outcome = null;
      run.interruptionKind = "ATTEMPT";
    },
    expected: "needs remaining quota",
  },
  {
    name: "Frozen Contract content identity cannot drift from Approval",
    baseline: () => stateAfter("contract-replacement-preserves-an-existing-run", 3),
    mutate(state) { state.contracts["contract-v1"].contentHash = "tampered-after-freeze"; },
    expected: "Approval for its exact content identity",
  },
  {
    name: "Contract and Run attempt limits cannot be synchronously changed after Approval",
    baseline: () => stateAfter("contract-replacement-preserves-an-existing-run", 4),
    mutate(state) {
      state.contracts["contract-v1"].maxAttempts = 1;
      state.runs["run-v1"].maxAttempts = 1;
    },
    expected: "Approval for its exact content identity and maxAttempts",
  },
  {
    name: "STARTED Attempt cannot already have a stable Candidate",
    baseline: () => stateAfter("confirmed-cancellation-cancels-only-the-active-attempt", 6),
    mutate(state) { state.attempts["attempt-cancel"].candidateId = "too-early-candidate"; },
    expected: "STARTED Attempt",
  },
  {
    name: "Candidate-bearing Attempt cannot lose Executor dispatch provenance",
    baseline: () => stateAfter("unacknowledged-dispatch-can-complete-before-cancel", 7),
    mutate(state) {
      state.attempts["attempt-unacknowledged-completion"].executorDispatchProvenance = null;
    },
    expected: "needs Executor dispatch provenance",
  },
  {
    name: "INTERRUPTED Candidate history cannot lose Executor dispatch provenance",
    baseline: () => stateAfter("verifying-interruption-with-room-can-end-inconclusive", 9),
    mutate(state) {
      state.attempts["attempt-interrupt-verifying-room"].executorDispatchProvenance = null;
    },
    expected: "Candidate-bearing Attempt",
  },
  {
    name: "INTERRUPTED verification history cannot lose its sealed Candidate",
    baseline: () => stateAfter("verifying-interruption-with-room-can-end-inconclusive", 9),
    mutate(state) {
      state.attempts["attempt-interrupt-verifying-room"].candidateId = null;
    },
    expected: "from VERIFYING must retain its Candidate",
  },
  {
    name: "CANCELLED Candidate history cannot lose Executor dispatch provenance",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "verifying-attempt-can-be-cancelled-before-adjudication",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "verifying-attempt-can-be-cancelled-before-adjudication",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-cancel-verifying"].executorDispatchProvenance = null;
    },
    expected: "Candidate-bearing Attempt",
  },
  {
    name: "CANCELLED verification history cannot lose its sealed Candidate",
    baseline: () => runSteps(
      fixtures.validScenarios.find(
        (item) => item.name === "verifying-attempt-can-be-cancelled-before-adjudication",
      ).tasks,
      fixtures.validScenarios.find(
        (item) => item.name === "verifying-attempt-can-be-cancelled-before-adjudication",
      ).steps,
    ),
    mutate(state) {
      state.attempts["attempt-cancel-verifying"].candidateId = null;
    },
    expected: "from VERIFYING must retain its Candidate",
  },
  {
    name: "unknown Executor dispatch provenance is rejected",
    baseline: () => stateAfter("unacknowledged-dispatch-can-complete-before-cancel", 7),
    mutate(state) {
      state.attempts["attempt-unacknowledged-completion"].executorDispatchProvenance =
        "DISPATCHED_AFTER_CANCEL";
    },
    expected: "unknown Executor dispatch provenance",
  },
  {
    name: "pre-cancel dispatch provenance needs a retained cancellation request",
    baseline: () => stateAfter("unacknowledged-dispatch-can-complete-before-cancel", 7),
    mutate(state) {
      state.attempts["attempt-unacknowledged-completion"].executorDispatchProvenance =
        "DISPATCHED_BEFORE_CANCEL";
    },
    expected: "needs the retained cancellation request",
  },
  {
    name: "late cancellation source cannot be forged",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "unknown-cancel-stop-can-later-receive-matching-confirmation").tasks,
      fixtures.validScenarios.find((item) => item.name === "unknown-cancel-stop-can-later-receive-matching-confirmation").steps,
    ),
    mutate(state) {
      state.runs["run-cancel-unknown"].outcome.cancelSource = "ACTIVE_STOP_CONFIRMED";
    },
    expected: "LATE_STOP_CONFIRMED",
  },
  {
    name: "post-cancel PASSED cannot lose safe convergence proof",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "executor-and-verifier-may-win-after-cancel-request").tasks,
      fixtures.validScenarios.find((item) => item.name === "executor-and-verifier-may-win-after-cancel-request").steps,
    ),
    mutate(state) {
      state.attempts["attempt-cancel-race-pass"].verdict.postCancelConvergenceSafe = false;
    },
    expected: "safe convergence proof",
  },
  {
    name: "ordinary PASSED cannot forge post-cancel convergence",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) {
      state.attempts["attempt-2"].verdict.postCancelConvergenceSafe = true;
    },
    expected: "needs a retained cancellation request and the final Attempt position",
  },
  {
    name: "PASSED Verdict cannot omit its boolean cancellation-order marker",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) {
      delete state.attempts["attempt-2"].verdict.postCancelConvergenceSafe;
    },
    expected: "needs a boolean post-cancel convergence marker",
  },
  {
    name: "FAILED Verdict cancellation-order marker must be boolean",
    baseline: () => stateAfter("failed-initial-attempt-repair-passes", 9),
    mutate(state) {
      state.attempts["attempt-1"].verdict.postCancelConvergenceSafe = "false";
    },
    expected: "needs a boolean post-cancel convergence marker",
  },
  {
    name: "a later child cancellation cannot restamp its historical FAILED parent",
    baseline: () => {
      let state = stateAfter("failed-initial-attempt-repair-passes", 12);
      state = applyOperation(state, {
        op: "REQUEST_CANCEL",
        runId: "run-repair",
        cancelRequestId: "cancel-repair-child-only",
      });
      return state;
    },
    mutate(state) {
      state.attempts["attempt-1"].verdict.postCancelConvergenceSafe = true;
    },
    expected: "needs a retained cancellation request and the final Attempt position",
  },
  {
    name: "post-cancel FAILED cannot erase its exact safe-convergence marker",
    baseline: () => {
      let state = stateAfter("failed-initial-attempt-repair-passes", 8);
      state = applyOperation(state, {
        op: "REQUEST_CANCEL",
        runId: "run-repair",
        cancelRequestId: "cancel-before-failed-adjudication",
      });
      return applyOperation(state, {
        op: "RECORD_FAILED_VERDICT",
        attemptId: "attempt-1",
        verdictId: "verdict-failed-after-cancel",
        postCancelConvergence: "PRE_DISPATCHED_OR_CONTAINED",
      });
    },
    mutate(state) {
      state.attempts["attempt-1"].verdict.postCancelConvergenceSafe = false;
    },
    expected: "must exactly reflect whether adjudication followed cancellation",
  },
  {
    name: "INCONCLUSIVE Verdict cannot carry post-cancel convergence metadata",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "interrupted-attempt-user-ends-inconclusive").tasks,
      fixtures.validScenarios.find((item) => item.name === "interrupted-attempt-user-ends-inconclusive").steps,
    ),
    mutate(state) {
      state.attempts["attempt-end-interrupted"].verdict.postCancelConvergenceSafe = false;
    },
    expected: "Only PASSED or FAILED AttemptVerdict",
  },
  {
    name: "POLICY_BLOCKED Verdict cannot carry post-cancel convergence metadata",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "in-attempt-permanent-policy-block-uses-verdict").tasks,
      fixtures.validScenarios.find((item) => item.name === "in-attempt-permanent-policy-block-uses-verdict").steps,
    ),
    mutate(state) {
      state.attempts["attempt-policy-active"].verdict.postCancelConvergenceSafe = false;
    },
    expected: "Only PASSED or FAILED AttemptVerdict",
  },
  {
    name: "PASSED Attempt cannot retain a ghost interruption Error",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) { state.attempts["attempt-2"].errorIds.push("ghost-error-on-pass"); },
    expected: "Only an ordinary INTERRUPTED Attempt",
  },
  {
    name: "interruption Error identities must remain an array",
    baseline: () => stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8),
    mutate(state) { state.attempts["attempt-interrupted"].errorIds = "error-disconnected"; },
    expected: "needs an append-only interruption Error identity list",
  },
  {
    name: "interruption Error identity cannot be empty",
    baseline: () => stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8),
    mutate(state) { state.attempts["attempt-interrupted"].errorIds = [""]; },
    expected: "interruption Error identities must be non-empty strings",
  },
  {
    name: "interruption Error identity must be a string",
    baseline: () => stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8),
    mutate(state) { state.attempts["attempt-interrupted"].errorIds = [123]; },
    expected: "interruption Error identities must be non-empty strings",
  },
  {
    name: "interruption Error identity cannot repeat inside one Attempt",
    baseline: () => stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8),
    mutate(state) {
      state.attempts["attempt-interrupted"].errorIds.push("error-disconnected");
    },
    expected: "Attempt interruption Error identity error-disconnected is duplicated",
  },
  {
    name: "interruption Error identity must be globally unique",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "interrupted-attempt-recovers-with-a-new-repair").tasks,
      fixtures.validScenarios.find((item) => item.name === "interrupted-attempt-recovers-with-a-new-repair").steps,
    ),
    mutate(state) {
      state.attempts["attempt-recovery"].errorIds.push("error-disconnected");
    },
    expected: "Attempt interruption Error identity error-disconnected is duplicated",
  },
  {
    name: "Recovery child cannot cite an Error absent from its direct parent",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "interrupted-attempt-recovers-with-a-new-repair").tasks,
      fixtures.validScenarios.find((item) => item.name === "interrupted-attempt-recovers-with-a-new-repair").steps,
    ),
    mutate(state) {
      state.attempts["attempt-recovery"].triggeringErrorId = "unowned-recovery-error";
    },
    expected: "needs its parent's Verdict or Error",
  },
  {
    name: "v0.1 ordinary interruption cannot claim multiple terminal Errors",
    baseline: () => stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8),
    mutate(state) {
      state.attempts["attempt-interrupted"].errorIds.push("second-terminal-error");
    },
    expected: "may retain at most one terminal Error",
  },
  {
    name: "CANCEL_STOP_UNKNOWN cannot retain a Recovery-trigger Error",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "unknown-stop-without-executor-start-ack-ends-inconclusive").tasks,
      fixtures.validScenarios.find((item) => item.name === "unknown-stop-without-executor-start-ack-ends-inconclusive").steps,
    ),
    mutate(state) {
      state.attempts["attempt-stop-unknown-started"].errorIds.push("ghost-cancel-stop-error");
    },
    expected: "Only an ordinary INTERRUPTED Attempt",
  },
  {
    name: "active Attempt cannot retain a terminal interruption Error",
    baseline: () => stateAfter("failed-initial-attempt-repair-passes", 7),
    mutate(state) { state.attempts["attempt-1"].errorIds.push("ghost-active-error"); },
    expected: "Only an ordinary INTERRUPTED Attempt",
  },
  {
    name: "VERIFYING unknown stop cannot be relabelled as an Executor stop",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "unknown-stop-during-verification-ends-inconclusive").tasks,
      fixtures.validScenarios.find((item) => item.name === "unknown-stop-during-verification-ends-inconclusive").steps,
    ),
    mutate(state) {
      state.attempts["attempt-stop-unknown-verifying"].unknownStopTarget = "EXECUTOR";
    },
    expected: "needs exact pre-cancel effect-capable verifier provenance",
  },
  {
    name: "VERIFYING unknown stop cannot lose verifier dispatch provenance",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "unknown-stop-during-verification-ends-inconclusive").tasks,
      fixtures.validScenarios.find((item) => item.name === "unknown-stop-during-verification-ends-inconclusive").steps,
    ),
    mutate(state) {
      state.attempts["attempt-stop-unknown-verifying"].verificationStopUnknownProvenance = null;
    },
    expected: "needs exact pre-cancel effect-capable verifier provenance",
  },
  {
    name: "ordinary interruption cannot forge unknown-stop provenance",
    baseline: () => stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8),
    mutate(state) {
      state.attempts["attempt-interrupted"].unknownStopTarget = "EXECUTOR";
    },
    expected: "cannot claim unknown-stop provenance",
  },
  {
    name: "Executor-phase unknown stop cannot forge verifier provenance",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "unknown-cancel-stop-can-later-receive-matching-confirmation").tasks,
      fixtures.validScenarios.find((item) => item.name === "unknown-cancel-stop-can-later-receive-matching-confirmation").steps,
    ),
    mutate(state) {
      const attempt = state.attempts["attempt-cancel-unknown"];
      attempt.unknownStopTarget = "VERIFICATION";
      attempt.verificationStopUnknownProvenance = verificationStopUnknownWitness;
    },
    expected: "needs exact EXECUTOR target provenance",
  },
  {
    name: "late cancellation confirmation cannot erase its unknown-stop target",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "unknown-cancel-stop-can-later-receive-matching-confirmation").tasks,
      fixtures.validScenarios.find((item) => item.name === "unknown-cancel-stop-can-later-receive-matching-confirmation").steps,
    ),
    mutate(state) { state.attempts["attempt-cancel-unknown"].unknownStopTarget = null; },
    expected: "needs exact EXECUTOR target provenance",
  },
  {
    name: "VERIFYING unknown-stop history must retain its sealed Candidate",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "unknown-stop-during-verification-ends-inconclusive").tasks,
      fixtures.validScenarios.find((item) => item.name === "unknown-stop-during-verification-ends-inconclusive").steps,
    ),
    mutate(state) { state.attempts["attempt-stop-unknown-verifying"].candidateId = null; },
    expected: "from VERIFYING must retain its Candidate",
  },
  {
    name: "POLICY_BLOCKED Attempt cannot lose its effect-quiescence proof",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "in-attempt-permanent-policy-block-uses-verdict").tasks,
      fixtures.validScenarios.find((item) => item.name === "in-attempt-permanent-policy-block-uses-verdict").steps,
    ),
    mutate(state) {
      state.attempts["attempt-policy-active"].terminalEffectQuiescenceProofId = null;
    },
    expected: "needs its effect-quiescence proof",
  },
  {
    name: "Policy terminalization proof identity cannot be empty",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "policy-block-before-executor-starts").tasks,
      fixtures.validScenarios.find((item) => item.name === "policy-block-before-executor-starts").steps,
    ),
    mutate(state) {
      state.attempts["attempt-policy-started"].terminalEffectQuiescenceProofId = "";
    },
    expected: "needs a non-empty identity",
  },
  {
    name: "Policy terminalization proof identity must be a string",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "policy-block-before-executor-starts").tasks,
      fixtures.validScenarios.find((item) => item.name === "policy-block-before-executor-starts").steps,
    ),
    mutate(state) {
      state.attempts["attempt-policy-started"].terminalEffectQuiescenceProofId = {};
    },
    expected: "needs a non-empty identity",
  },
  {
    name: "Policy terminalization proof identity must be globally unique",
    baseline: () => {
      const scenario = fixtures.validScenarios.find(
        (item) => item.name === "in-attempt-permanent-policy-block-uses-verdict",
      );
      let state = runSteps(scenario.tasks, scenario.steps);
      state = applyOperation(state, {
        op: "CREATE_RUN",
        runId: "run-policy-active-second",
        contractId: "contract-policy-active",
      });
      state = applyOperation(state, {
        op: "START_PREFLIGHT",
        runId: "run-policy-active-second",
      });
      state = applyOperation(state, {
        op: "START_INITIAL_ATTEMPT",
        runId: "run-policy-active-second",
        attemptId: "attempt-policy-active-second",
      });
      state = applyOperation(state, {
        op: "IN_ATTEMPT_POLICY_BLOCKED",
        attemptId: "attempt-policy-active-second",
        verdictId: "verdict-policy-active-second",
        effectQuiescence: effectQuiescenceWitness,
        effectQuiescenceProofId: "policy-quiescence-active-second",
      });
      return state;
    },
    mutate(state) {
      state.attempts["attempt-policy-active-second"].terminalEffectQuiescenceProofId =
        "policy-quiescence-active";
    },
    expected: "Policy terminalization proof identity policy-quiescence-active is duplicated",
  },
  {
    name: "non-Policy Attempt cannot forge a Policy terminalization proof",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
      fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
    ),
    mutate(state) {
      state.attempts["attempt-2"].terminalEffectQuiescenceProofId = "forged-policy-proof";
    },
    expected: "Only a POLICY_BLOCKED FINISHED Attempt",
  },
  {
    name: "VERIFYING Policy block must retain its sealed Candidate",
    baseline: () => runSteps(
      fixtures.validScenarios.find((item) => item.name === "policy-block-after-candidate-is-sealed").tasks,
      fixtures.validScenarios.find((item) => item.name === "policy-block-after-candidate-is-sealed").steps,
    ),
    mutate(state) {
      state.attempts["attempt-policy-verifying"].candidateId = null;
    },
    expected: "from VERIFYING must retain its Candidate",
  },
];

test("declared invariant mutations turn valid snapshots into invalid snapshots", () => {
  for (const mutation of invariantMutations) {
    const state = mutation.baseline();
    assert.deepEqual(validateState(state), [], `${mutation.name}: baseline`);
    mutation.mutate(state);
    const errors = validateState(state);
    assert.ok(errors.length > 0, `${mutation.name} unexpectedly passed`);
    assert.ok(
      errors.some((error) => error.includes(mutation.expected)),
      `${mutation.name}: expected ${mutation.expected}; received ${errors.join(" | ")}`,
    );
  }
});

test("a rejected operation cannot alter the last valid state", () => {
  const state = stateAfter("failed-initial-attempt-repair-passes", 9);
  const before = structuredClone(state);
  assert.throws(
    () => applyOperation(state, {
      op: "RECORD_PASSED_VERDICT",
      attemptId: "attempt-1",
      verdictId: "replacement-verdict",
    }),
    /VERIFYING/i,
  );
  assert.deepEqual(state, before);
});

test("replacement and terminal judgments cannot be reopened or washed away", () => {
  const replacement = runSteps(
    fixtures.validScenarios.find((item) => item.name === "contract-replacement-preserves-an-existing-run").tasks,
    fixtures.validScenarios.find((item) => item.name === "contract-replacement-preserves-an-existing-run").steps,
  );
  assert.throws(
    () => applyOperation(replacement, {
      op: "CREATE_RUN",
      runId: "late-run",
      contractId: "contract-v1",
      maxAttempts: 2,
    }),
    /currently FROZEN/i,
  );

  const awaitingRepair = stateAfter("failed-initial-attempt-repair-passes", 9);
  assert.throws(
    () => applyOperation(awaitingRepair, {
      op: "REQUEST_CANCEL",
      runId: "run-repair",
    }),
    /FAILED RunOutcome/i,
  );

  const interrupted = stateAfter("interrupted-attempt-recovers-with-a-new-repair", 8);
  assert.throws(
    () => applyOperation(interrupted, {
      op: "REQUEST_CANCEL",
      runId: "run-recovery",
    }),
    /end INCONCLUSIVE or start Recovery/i,
  );

  const finished = runSteps(
    fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").tasks,
    fixtures.validScenarios.find((item) => item.name === "failed-initial-attempt-repair-passes").steps,
  );
  const before = structuredClone(finished);
  assert.throws(
    () => applyOperation(finished, {
      op: "REQUEST_CANCEL",
      runId: "run-repair",
    }),
    /terminal Run/i,
  );
  assert.deepEqual(finished, before);
});
