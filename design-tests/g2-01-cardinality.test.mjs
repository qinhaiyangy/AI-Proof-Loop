import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// This validates the G2-01 abstract relationship graph. It intentionally does
// not freeze the runtime/API/storage shapes assigned to later Gate 2 sub-gates.

const fixturePath = new URL(
  "../docs/domain/examples/g2-01-object-graphs.json",
  import.meta.url,
);
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));

const activeAttemptStates = new Set(["STARTED", "EXECUTING", "VERIFYING"]);
const terminalRunStates = new Set(["FINISHED", "CANCELLED"]);

function uniqueMap(items, key, errors, label) {
  const result = new Map();
  for (const item of items) {
    const id = item[key];
    if (!id || result.has(id)) {
      errors.push(`${label} has a missing or duplicate ${key}`);
      continue;
    }
    result.set(id, item);
  }
  return result;
}

function validateGraph(graph) {
  const errors = [];
  const tasks = uniqueMap(graph.tasks ?? [], "taskId", errors, "Task");
  const contracts = uniqueMap(
    graph.contracts ?? [],
    "contractVersionId",
    errors,
    "Contract Version",
  );
  const runs = uniqueMap(graph.runs ?? [], "runId", errors, "Run");
  const attempts = uniqueMap(
    graph.attempts ?? [],
    "attemptId",
    errors,
    "Attempt",
  );
  const evidence = uniqueMap(
    graph.evidence ?? [],
    "evidenceId",
    errors,
    "Evidence",
  );
  const interfaceReceipts = uniqueMap(
    graph.interfaceReceipts ?? [],
    "receiptId",
    errors,
    "Receipt",
  );
  const terminalEvents = uniqueMap(
    graph.terminalEvents ?? [],
    "eventId",
    errors,
    "Terminal Event",
  );
  const verdicts = new Map();
  const approvalIds = new Set();
  const runOutcomeIds = new Set();
  for (const attempt of attempts.values()) {
    const verdict = attempt.attemptVerdict;
    if (!verdict) continue;
    if (!verdict.attemptVerdictId || verdicts.has(verdict.attemptVerdictId)) {
      errors.push(`AttemptVerdict has a missing or duplicate attemptVerdictId`);
      continue;
    }
    verdicts.set(verdict.attemptVerdictId, { attempt, verdict });
  }

  for (const contract of contracts.values()) {
    if (!tasks.has(contract.taskId)) {
      errors.push(`Contract Version ${contract.contractVersionId} has no owning Task`);
    }
    if (!Array.isArray(contract.criteria) || contract.criteria.length === 0) {
      errors.push(`Contract Version ${contract.contractVersionId} needs at least one Criterion`);
    } else if (!contract.criteria.some((criterion) => criterion.mandatory)) {
      errors.push(`Contract Version ${contract.contractVersionId} needs a mandatory Criterion`);
    }
    if (
      !Number.isInteger(contract.maxAttempts) ||
      contract.maxAttempts < 1 ||
      contract.maxAttempts > 2
    ) {
      errors.push(`Contract Version ${contract.contractVersionId} needs maxAttempts from 1 to 2`);
    }

    const criterionIds = new Set();
    for (const criterion of contract.criteria ?? []) {
      if (!criterion.criterionId || criterionIds.has(criterion.criterionId)) {
        errors.push(`Contract Version ${contract.contractVersionId} has duplicate Criteria`);
      }
      criterionIds.add(criterion.criterionId);
    }

    const snapshotHashes = new Set();
    const snapshotIds = new Set();
    for (const snapshot of contract.skillSnapshots ?? []) {
      if (
        !snapshot.snapshotId ||
        snapshotIds.has(snapshot.snapshotId) ||
        !snapshot.contentHash ||
        snapshotHashes.has(snapshot.contentHash)
      ) {
        errors.push(`Contract Version ${contract.contractVersionId} has duplicate Skill Snapshots`);
      }
      snapshotIds.add(snapshot.snapshotId);
      snapshotHashes.add(snapshot.contentHash);
    }

    if (["FROZEN", "SUPERSEDED"].includes(contract.status)) {
      if (!contract.approval) {
        errors.push(`Executable Contract Version ${contract.contractVersionId} has no Approval`);
      } else {
        if (
          !contract.approval.approvalId ||
          approvalIds.has(contract.approval.approvalId)
        ) {
          errors.push(`Contract Approval has a missing or duplicate approvalId`);
        }
        approvalIds.add(contract.approval.approvalId);
        if (!contract.contractHash || !contract.approval.approvedContractHash) {
          errors.push(`Executable Contract Version ${contract.contractVersionId} needs both content identities`);
        }
        if (contract.approval.contractVersionId !== contract.contractVersionId) {
          errors.push(`Approval targets the wrong Contract Version`);
        }
        if (contract.approval.approvedContractHash !== contract.contractHash) {
          errors.push(`Approval targets the wrong Contract content identity`);
        }
      }
    }
    if (contract.status === "SUPERSEDED") {
      const successor = contracts.get(contract.supersededByContractVersionId);
      if (
        !successor ||
        successor.contractVersionId === contract.contractVersionId ||
        successor.taskId !== contract.taskId
      ) {
        errors.push(`SUPERSEDED Contract Version ${contract.contractVersionId} needs one same-Task successor`);
      }
    } else if (contract.supersededByContractVersionId) {
      errors.push(`Only a SUPERSEDED Contract Version may identify a successor`);
    }
  }

  for (const run of runs.values()) {
    const contract = contracts.get(run.contractVersionId);
    if (!tasks.has(run.taskId)) {
      errors.push(`Run ${run.runId} has no owning Task`);
    }
    if (!contract) {
      errors.push(`Run ${run.runId} has no governing Contract Version`);
      continue;
    }
    if (!["FROZEN", "SUPERSEDED"].includes(contract.status)) {
      errors.push(`Run ${run.runId} must reference a FROZEN Contract Version`);
    }
    if (
      run.contractStatusAtBinding !== "FROZEN" ||
      !run.boundContractHash ||
      run.boundContractHash !== contract.contractHash
    ) {
      errors.push(`Run ${run.runId} needs its exact FROZEN Contract binding`);
    }
    if (contract.taskId !== run.taskId) {
      errors.push(`Run ${run.runId} crosses the Task ownership boundary`);
    }

    const runAttempts = (run.attemptIds ?? [])
      .map((attemptId) => attempts.get(attemptId))
      .filter(Boolean);
    if (new Set(run.attemptIds ?? []).size !== (run.attemptIds ?? []).length) {
      errors.push(`Run ${run.runId} lists the same Attempt more than once`);
    }
    if (runAttempts.length !== (run.attemptIds ?? []).length) {
      errors.push(`Run ${run.runId} references an unknown Attempt`);
    }
    if (runAttempts.some((attempt) => attempt.runId !== run.runId)) {
      errors.push(`Run ${run.runId} references an Attempt owned by another Run`);
    }
    if (runAttempts.length > contract.maxAttempts) {
      errors.push(`Run ${run.runId} exceeds maxAttempts`);
    }
    if (runAttempts.length > 0) {
      if (runAttempts[0]?.kind !== "INITIAL") {
        errors.push(`Run ${run.runId} must start with one Initial Attempt`);
      }
      if (runAttempts.filter((attempt) => attempt.kind === "INITIAL").length !== 1) {
        errors.push(`Run ${run.runId} must contain exactly one Initial Attempt`);
      }
    }
    if (runAttempts.filter((attempt) => activeAttemptStates.has(attempt.status)).length > 1) {
      errors.push(`Run ${run.runId} has more than one Active Attempt`);
    }

    const terminal = terminalRunStates.has(run.status);
    if (terminal && !run.runOutcome) {
      errors.push(`Terminal Run ${run.runId} needs exactly one RunOutcome`);
    }
    if (!terminal && run.runOutcome) {
      errors.push(`Nonterminal Run ${run.runId} cannot have a RunOutcome`);
    }
    if (run.runOutcome) {
      if (
        !run.runOutcome.runOutcomeId ||
        runOutcomeIds.has(run.runOutcome.runOutcomeId)
      ) {
        errors.push(`RunOutcome has a missing or duplicate runOutcomeId`);
      }
      runOutcomeIds.add(run.runOutcome.runOutcomeId);
    }
    const hasVerdictBasis = Boolean(run.runOutcome?.finalAttemptVerdictId);
    const hasEventBasis = Boolean(run.runOutcome?.terminalEventId);
    if (run.runOutcome && Number(hasVerdictBasis) + Number(hasEventBasis) !== 1) {
      errors.push(`RunOutcome ${run.runOutcome.runOutcomeId} needs exactly one terminal basis`);
    }
    if (hasVerdictBasis) {
      const finalVerdict = verdicts.get(run.runOutcome.finalAttemptVerdictId);
      if (!finalVerdict || finalVerdict.attempt.runId !== run.runId) {
        errors.push(`RunOutcome ${run.runOutcome.runOutcomeId} references another Run's Verdict`);
      } else if (run.runOutcome.value !== finalVerdict.verdict.value) {
        errors.push(`RunOutcome ${run.runOutcome.runOutcomeId} must match its final AttemptVerdict`);
      }
      const finalAttempt = runAttempts.at(-1);
      if (
        finalAttempt?.attemptVerdict?.attemptVerdictId !==
        run.runOutcome.finalAttemptVerdictId
      ) {
        errors.push(`RunOutcome ${run.runOutcome.runOutcomeId} must reference its final Attempt's Verdict`);
      }
    } else if (hasEventBasis) {
      const terminalEvent = terminalEvents.get(run.runOutcome.terminalEventId);
      if (
        !terminalEvent ||
        terminalEvent.runId !== run.runId ||
        terminalEvent.outcome !== run.runOutcome.value
      ) {
        errors.push(`RunOutcome ${run.runOutcome.runOutcomeId} needs its matching terminal Event`);
      }
      if (
        run.runOutcome.value === "POLICY_BLOCKED" &&
        runAttempts.length !== 0
      ) {
        errors.push(`Pre-Attempt POLICY_BLOCKED RunOutcome requires zero Attempts`);
      }
      if (!["POLICY_BLOCKED", "CANCELLED"].includes(run.runOutcome.value)) {
        errors.push(`Only POLICY_BLOCKED or CANCELLED may use a terminal Event basis`);
      }
    }
  }

  for (const attempt of attempts.values()) {
    const run = runs.get(attempt.runId);
    if (!run) {
      errors.push(`Attempt ${attempt.attemptId} has no owning Run`);
      continue;
    }
    const contract = contracts.get(run.contractVersionId);
    if (!contract) continue;

    const ownershipReferenceCount = [...runs.values()].reduce(
      (count, candidateRun) =>
        count +
        (candidateRun.attemptIds ?? []).filter(
          (attemptId) => attemptId === attempt.attemptId,
        ).length,
      0,
    );
    if (ownershipReferenceCount !== 1) {
      errors.push(`Attempt ${attempt.attemptId} must be owned by exactly one Run`);
    }

    if (attempt.kind === "INITIAL") {
      if (
        attempt.parentAttemptId ||
        attempt.triggeringVerdictId ||
        attempt.triggeringErrorId
      ) {
        errors.push(`Initial Attempt ${attempt.attemptId} cannot have Repair lineage`);
      }
    } else if (attempt.kind === "REPAIR") {
      const parent = attempts.get(attempt.parentAttemptId);
      if (!parent || parent.runId !== attempt.runId) {
        errors.push(`Repair Attempt ${attempt.attemptId} needs a parent in the same Run`);
      } else if (
        (run.attemptIds ?? []).indexOf(parent.attemptId) >=
        (run.attemptIds ?? []).indexOf(attempt.attemptId)
      ) {
        errors.push(`Repair Attempt ${attempt.attemptId} must follow its parent`);
      }
      const triggerCount = Number(Boolean(attempt.triggeringVerdictId)) +
        Number(Boolean(attempt.triggeringErrorId));
      if (triggerCount !== 1) {
        errors.push(`Repair Attempt ${attempt.attemptId} needs exactly one trigger`);
      }
      if (
        attempt.triggeringVerdictId &&
        parent?.attemptVerdict?.attemptVerdictId !== attempt.triggeringVerdictId
      ) {
        errors.push(`Repair Attempt ${attempt.attemptId} must reference its parent's Verdict`);
      }
      if (
        attempt.triggeringErrorId &&
        !(parent?.executionErrorIds ?? []).includes(attempt.triggeringErrorId)
      ) {
        errors.push(`Repair Attempt ${attempt.attemptId} must reference its parent's Error`);
      }
    } else {
      errors.push(`Attempt ${attempt.attemptId} has an unknown kind`);
    }

    if (!attempt.attemptVerdict) continue;
    if (
      !attempt.candidateHash &&
      !["INCONCLUSIVE", "POLICY_BLOCKED"].includes(attempt.attemptVerdict.value)
    ) {
      errors.push(`Attempt ${attempt.attemptId} has a Verdict without a Candidate`);
    }

    const expectedCriterionIds = new Set(
      contract.criteria.map((criterion) => criterion.criterionId),
    );
    const seenCriterionIds = new Set();
    for (const outcome of attempt.attemptVerdict.criterionOutcomes ?? []) {
      if (!expectedCriterionIds.has(outcome.criterionId)) {
        errors.push(`Attempt ${attempt.attemptId} has an Outcome for another Contract`);
      }
      if (seenCriterionIds.has(outcome.criterionId)) {
        errors.push(`Attempt ${attempt.attemptId} has duplicate CriterionOutcomes`);
      }
      seenCriterionIds.add(outcome.criterionId);

      for (const evidenceId of outcome.evidenceIds ?? []) {
        const item = evidence.get(evidenceId);
        if (!item) {
          errors.push(`Attempt ${attempt.attemptId} references unknown Evidence`);
          continue;
        }
        if (item.kind !== "CRITERION") {
          errors.push(`Attempt ${attempt.attemptId} uses GovernanceEvidence as CriterionEvidence`);
        }
        if (item.attemptId !== attempt.attemptId) {
          errors.push(`Attempt ${attempt.attemptId} uses Evidence from another Attempt`);
        }
        if (item.candidateHash !== attempt.candidateHash) {
          errors.push(`Attempt ${attempt.attemptId} uses Evidence from another Candidate`);
        }
        if (!(item.criterionIds ?? []).includes(outcome.criterionId)) {
          errors.push(`Evidence ${evidenceId} does not map to Criterion ${outcome.criterionId}`);
        }
      }
    }
    if (
      seenCriterionIds.size !== expectedCriterionIds.size ||
      [...expectedCriterionIds].some((criterionId) => !seenCriterionIds.has(criterionId))
    ) {
      errors.push(`Attempt ${attempt.attemptId} needs exactly one Outcome per Criterion`);
    }

    const mandatoryOutcomes = (attempt.attemptVerdict.criterionOutcomes ?? []).filter(
      (outcome) =>
        contract.criteria.find(
          (criterion) => criterion.criterionId === outcome.criterionId,
        )?.mandatory,
    );
    const allMandatorySatisfied = mandatoryOutcomes.every(
      (outcome) => outcome.value === "SATISFIED" && outcome.evidenceIds?.length > 0,
    );
    if (attempt.attemptVerdict.value === "PASSED" && !allMandatorySatisfied) {
      errors.push(`Attempt ${attempt.attemptId} cannot PASS without satisfied mandatory Criteria`);
    }
    if (attempt.attemptVerdict.value === "FAILED" && allMandatorySatisfied) {
      errors.push(`Attempt ${attempt.attemptId} cannot FAIL when all mandatory Criteria are satisfied`);
    }
  }

  for (const item of evidence.values()) {
    if (item.kind === "CRITERION") {
      const attempt = attempts.get(item.attemptId);
      if (!attempt) {
        errors.push(`CriterionEvidence ${item.evidenceId} has no owning Attempt`);
        continue;
      }
      if (!item.candidateHash || item.candidateHash !== attempt.candidateHash) {
        errors.push(`CriterionEvidence ${item.evidenceId} has the wrong Candidate identity`);
      }
      const run = runs.get(attempt.runId);
      if (
        !run ||
        item.taskId !== run.taskId ||
        item.contractVersionId !== run.contractVersionId ||
        item.runId !== run.runId
      ) {
        errors.push(`CriterionEvidence ${item.evidenceId} crosses its scope ancestry`);
      }
      if (!Array.isArray(item.criterionIds) || item.criterionIds.length === 0) {
        errors.push(`CriterionEvidence ${item.evidenceId} maps to no Criteria`);
      } else {
        const contract = run ? contracts.get(run.contractVersionId) : undefined;
        const validCriterionIds = new Set(
          (contract?.criteria ?? []).map((criterion) => criterion.criterionId),
        );
        if (item.criterionIds.some((criterionId) => !validCriterionIds.has(criterionId))) {
          errors.push(`CriterionEvidence ${item.evidenceId} maps outside its Contract Version`);
        }
      }
    } else if (item.kind === "GOVERNANCE") {
      let validScopeOwner = false;
      if (item.scope === "CONTRACT") {
        const contract = contracts.get(item.contractVersionId);
        validScopeOwner = Boolean(
          contract && item.taskId === contract.taskId && !item.runId && !item.attemptId,
        );
      } else if (item.scope === "RUN") {
        const run = runs.get(item.runId);
        validScopeOwner = Boolean(
          run &&
            item.taskId === run.taskId &&
            item.contractVersionId === run.contractVersionId &&
            !item.attemptId,
        );
      } else if (item.scope === "ATTEMPT") {
        const attempt = attempts.get(item.attemptId);
        const run = attempt ? runs.get(attempt.runId) : undefined;
        validScopeOwner = Boolean(
          attempt &&
            run &&
            item.taskId === run.taskId &&
            item.contractVersionId === run.contractVersionId &&
            item.runId === run.runId,
        );
      }
      if (!validScopeOwner) {
        errors.push(`GovernanceEvidence ${item.evidenceId} has an invalid scope owner`);
      }
      if (item.criterionIds) {
        errors.push(`GovernanceEvidence ${item.evidenceId} cannot map to behavioral Criteria`);
      }
    } else {
      errors.push(`Evidence ${item.evidenceId} has an unknown variant`);
    }
  }

  for (const receipt of interfaceReceipts.values()) {
    if (!receipt.accepted || !["CREATE_TASK", "CREATE_RUN"].includes(receipt.commandType)) {
      continue;
    }
    const target = receipt.targetRef;
    const expectedTargetKind = receipt.commandType === "CREATE_TASK" ? "TASK" : "RUN";
    const targetExists = expectedTargetKind === "TASK"
      ? tasks.has(target?.id)
      : runs.has(target?.id);
    if (target?.kind !== expectedTargetKind || !targetExists) {
      errors.push(`Accepted create Receipt ${receipt.receiptId} needs its TargetRef`);
    }
  }

  for (const task of tasks.values()) {
    const creationReceipts = [...interfaceReceipts.values()].filter(
      (receipt) =>
        receipt.accepted &&
        receipt.commandType === "CREATE_TASK" &&
        receipt.targetRef?.kind === "TASK" &&
        receipt.targetRef.id === task.taskId,
    );
    if (creationReceipts.length !== 1) {
      errors.push(`Task ${task.taskId} needs exactly one logical creation Receipt`);
    }
  }

  for (const run of runs.values()) {
    const creationReceipts = [...interfaceReceipts.values()].filter(
      (receipt) =>
        receipt.accepted &&
        receipt.commandType === "CREATE_RUN" &&
        receipt.targetRef?.kind === "RUN" &&
        receipt.targetRef.id === run.runId,
    );
    if (creationReceipts.length !== 1) {
      errors.push(`Run ${run.runId} needs exactly one logical creation Receipt`);
    }
  }

  return errors;
}

test("all legal G2-01 object graphs satisfy the cardinality contract", () => {
  for (const fixture of fixtures.valid) {
    assert.deepEqual(validateGraph(fixture.graph), [], fixture.name);
  }
});

test("all illegal G2-01 object graphs are rejected for the expected reason", () => {
  for (const fixture of fixtures.invalid) {
    const errors = validateGraph(fixture.graph);
    assert.ok(errors.length > 0, `${fixture.name} unexpectedly passed`);
    assert.ok(
      errors.some((error) => error.includes(fixture.expectedError)),
      `${fixture.name}: expected ${fixture.expectedError}; received ${errors.join(" | ")}`,
    );
  }
});

test("a historical Run remains legal after its Contract Version is superseded", () => {
  const graph = structuredClone(
    fixtures.valid.find(
      (fixture) => fixture.name === "failed-attempt-then-passing-repair",
    ).graph,
  );
  graph.contracts[0].status = "SUPERSEDED";
  graph.contracts[0].supersededByContractVersionId = "task-todo:v2";
  graph.contracts.push({
    contractVersionId: "task-todo:v2",
    taskId: "task-todo",
    status: "FROZEN",
    contractHash: "contract-todo-v2-hash",
    maxAttempts: 2,
    approval: {
      approvalId: "approval-todo-v2",
      contractVersionId: "task-todo:v2",
      approvedContractHash: "contract-todo-v2-hash",
    },
    skillSnapshots: [],
    criteria: [{ criterionId: "criterion-v2", mandatory: true }],
  });
  assert.deepEqual(validateGraph(graph), []);
});

test("a cancelled Run may retain a cancelled Attempt without inventing a Verdict", () => {
  const graph = structuredClone(
    fixtures.valid.find(
      (fixture) => fixture.name === "preflight-with-zero-attempts",
    ).graph,
  );
  graph.attempts.push({
    attemptId: "attempt-cancelled",
    runId: "run-preflight",
    kind: "INITIAL",
    status: "CANCELLED",
    candidateHash: null,
    parentAttemptId: null,
    triggeringVerdictId: null,
    triggeringErrorId: null,
    attemptVerdict: null,
  });
  graph.runs[0].attemptIds = ["attempt-cancelled"];
  graph.runs[0].status = "CANCELLED";
  graph.runs[0].runOutcome = {
    runOutcomeId: "outcome-cancelled",
    value: "CANCELLED",
    terminalEventId: "event-cancelled",
  };
  graph.terminalEvents = [
    {
      eventId: "event-cancelled",
      runId: "run-preflight",
      outcome: "CANCELLED",
    },
  ];
  assert.deepEqual(validateGraph(graph), []);
});

test("a pre-Attempt Policy block has one matching terminal Event", () => {
  const graph = structuredClone(
    fixtures.valid.find(
      (fixture) => fixture.name === "preflight-with-zero-attempts",
    ).graph,
  );
  graph.runs[0].status = "FINISHED";
  graph.runs[0].runOutcome = {
    runOutcomeId: "outcome-policy-blocked",
    value: "POLICY_BLOCKED",
    terminalEventId: "event-policy-blocked",
  };
  graph.terminalEvents = [
    {
      eventId: "event-policy-blocked",
      runId: "run-preflight",
      outcome: "POLICY_BLOCKED",
    },
  ];
  assert.deepEqual(validateGraph(graph), []);
});

test("an INCONCLUSIVE Attempt may have no stable Candidate", () => {
  const graph = structuredClone(
    fixtures.valid.find(
      (fixture) => fixture.name === "failed-attempt-then-passing-repair",
    ).graph,
  );
  const attempt = graph.attempts[1];
  attempt.status = "INTERRUPTED";
  attempt.candidateHash = null;
  attempt.attemptVerdict.value = "INCONCLUSIVE";
  attempt.attemptVerdict.criterionOutcomes = graph.contracts[0].criteria.map(
    ({ criterionId }) => ({
      criterionId,
      value: "INSUFFICIENT_EVIDENCE",
      evidenceIds: [],
    }),
  );
  graph.evidence = graph.evidence.filter(
    (item) => item.kind !== "CRITERION" || item.attemptId !== attempt.attemptId,
  );
  graph.runs[0].runOutcome.value = "INCONCLUSIVE";
  assert.deepEqual(validateGraph(graph), []);
});

const mutationCases = [
  {
    name: "Repair trigger does not identify its parent's Verdict",
    expectedError: "must reference its parent's Verdict",
    mutate(graph) {
      graph.attempts[1].triggeringVerdictId = "missing-verdict";
    },
  },
  {
    name: "Repair trigger does not identify its parent's Error",
    expectedError: "must reference its parent's Error",
    mutate(graph) {
      graph.attempts[1].triggeringVerdictId = null;
      graph.attempts[1].triggeringErrorId = "missing-error";
    },
  },
  {
    name: "Attempt is omitted from its owning Run",
    expectedError: "must be owned by exactly one Run",
    mutate(graph) {
      graph.runs[0].attemptIds = ["attempt-1"];
    },
  },
  {
    name: "Run lists an Attempt twice",
    expectedError: "lists the same Attempt more than once",
    mutate(graph) {
      graph.runs[0].attemptIds.push("attempt-2");
    },
  },
  {
    name: "Run contains a second Initial Attempt",
    expectedError: "must contain exactly one Initial Attempt",
    mutate(graph) {
      graph.attempts[1].kind = "INITIAL";
      graph.attempts[1].parentAttemptId = null;
      graph.attempts[1].triggeringVerdictId = null;
    },
  },
  {
    name: "unused CriterionEvidence maps outside its Contract Version",
    expectedError: "maps outside its Contract Version",
    mutate(graph) {
      graph.evidence.push({
        evidenceId: "evidence-invalid-mapping",
        kind: "CRITERION",
        taskId: "task-todo",
        contractVersionId: "task-todo:v1",
        runId: "run-todo",
        attemptId: "attempt-2",
        candidateHash: "candidate-2-hash",
        criterionIds: ["criterion-from-another-contract"],
      });
    },
  },
  {
    name: "GovernanceEvidence identifies a missing scope owner",
    expectedError: "has an invalid scope owner",
    mutate(graph) {
      const item = graph.evidence.find(
        (candidate) => candidate.evidenceId === "governance-baseline",
      );
      item.runId = "missing-run";
    },
  },
  {
    name: "maxAttempts exceeds the v0.1 contract",
    expectedError: "needs maxAttempts from 1 to 2",
    mutate(graph) {
      graph.contracts[0].maxAttempts = 3;
    },
  },
  {
    name: "maxAttempts cannot be zero",
    expectedError: "needs maxAttempts from 1 to 2",
    mutate(graph) {
      graph.contracts[0].maxAttempts = 0;
    },
  },
  {
    name: "maxAttempts must be an integer",
    expectedError: "needs maxAttempts from 1 to 2",
    mutate(graph) {
      graph.contracts[0].maxAttempts = 1.5;
    },
  },
  {
    name: "accepted create Receipt omits TargetRef",
    expectedError: "needs its TargetRef",
    mutate(graph) {
      graph.interfaceReceipts.find(
        (receipt) => receipt.commandType === "CREATE_RUN",
      ).targetRef = null;
    },
  },
  {
    name: "PASSED RunOutcome points to a FAILED AttemptVerdict",
    expectedError: "must match its final AttemptVerdict",
    mutate(graph) {
      graph.runs[0].runOutcome.finalAttemptVerdictId = "verdict-1";
    },
  },
  {
    name: "RunOutcome has no final basis",
    expectedError: "needs exactly one terminal basis",
    mutate(graph) {
      delete graph.runs[0].runOutcome.finalAttemptVerdictId;
    },
  },
  {
    name: "RunOutcome has two competing terminal bases",
    expectedError: "needs exactly one terminal basis",
    mutate(graph) {
      graph.runs[0].runOutcome.terminalEventId = "extra-terminal-event";
    },
  },
  {
    name: "Frozen Contract and Approval have no content identity",
    expectedError: "needs both content identities",
    mutate(graph) {
      delete graph.contracts[0].contractHash;
      delete graph.contracts[0].approval.approvedContractHash;
    },
  },
  {
    name: "AttemptVerdict identity is duplicated",
    expectedError: "missing or duplicate attemptVerdictId",
    mutate(graph) {
      graph.attempts[1].attemptVerdict.attemptVerdictId = "verdict-1";
    },
  },
  {
    name: "RunOutcome identity is missing",
    expectedError: "missing or duplicate runOutcomeId",
    mutate(graph) {
      delete graph.runs[0].runOutcome.runOutcomeId;
    },
  },
  {
    name: "CREATE_TASK Receipt points to a Run TargetRef",
    expectedError: "needs its TargetRef",
    mutate(graph) {
      const receipt = graph.interfaceReceipts.find(
        (candidate) => candidate.commandType === "CREATE_TASK",
      );
      receipt.targetRef = { kind: "RUN", id: "run-todo" };
    },
  },
  {
    name: "SUPERSEDED Contract Version has no successor",
    expectedError: "needs one same-Task successor",
    mutate(graph) {
      graph.contracts[0].status = "SUPERSEDED";
    },
  },
];

test("each declared cardinality break turns a legal graph into an illegal graph", () => {
  const baseline = fixtures.valid.find(
    (fixture) => fixture.name === "failed-attempt-then-passing-repair",
  ).graph;
  assert.deepEqual(validateGraph(baseline), [], "mutation baseline must be legal");

  for (const fixture of mutationCases) {
    const graph = structuredClone(baseline);
    fixture.mutate(graph);
    const errors = validateGraph(graph);
    assert.ok(errors.length > 0, `${fixture.name} unexpectedly passed`);
    assert.ok(
      errors.some((error) => error.includes(fixture.expectedError)),
      `${fixture.name}: expected ${fixture.expectedError}; received ${errors.join(" | ")}`,
    );
  }
});
