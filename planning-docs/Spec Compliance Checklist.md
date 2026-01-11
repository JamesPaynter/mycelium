## Verification Approach

### 1. Spec Compliance Checklist

A checklist derived directly from this spec. Each item is binary: implemented or not.

```markdown
# Spec Compliance Checklist

## Components
- [ ] Orchestrator exists and runs
- [ ] Planner calls LLM and outputs structured JSON
- [ ] Worker runs in Docker container
- [ ] Worker uses Codex SDK with runStreamed()
- [ ] Test Validator runs on changed tests
- [ ] Doctor Validator runs periodically
- [ ] Log Query system works

## Configuration
- [ ] Project config loads from yaml
- [ ] Resources defined and used for scheduling
- [ ] Planner provider/model configurable
- [ ] Worker model configurable
- [ ] max_parallel respected
- [ ] max_retries respected

## Scheduling
- [ ] Batches built from resource locks
- [ ] read + read = parallel
- [ ] read + write = sequential
- [ ] write + read = sequential
- [ ] write + write = sequential

## Docker
- [ ] Container created per task
- [ ] Container gets own branch
- [ ] Container isolated from others
- [ ] Logs streamed to orchestrator
- [ ] Container cleaned up after success

## Git
- [ ] Branch created per task: agent/<id>-<name>
- [ ] Commits made on task branch
- [ ] Batch merges to development-codex
- [ ] Integration doctor runs after merge

## Worker Loop
- [ ] Loads spec.md and manifest.json
- [ ] Calls Codex runStreamed()
- [ ] Runs doctor after execution
- [ ] Retries on doctor failure
- [ ] Feeds error back to Codex on retry
- [ ] Logs access requests for undeclared files
- [ ] Commits on success
- [ ] Exits 0 on success, 1 on failure

## Logging
- [ ] Orchestrator events to orchestrator.jsonl
- [ ] Task events to tasks/<id>/events.jsonl
- [ ] Doctor output to doctor-<attempt>.log
- [ ] All events have timestamp
- [ ] All events have correct type

## State & Resume
- [ ] State persisted to JSON file
- [ ] State updated after each task completion
- [ ] Resume loads state and continues
- [ ] Running tasks restarted on resume
- [ ] Completed tasks skipped on resume

## Validators
- [ ] Test validator checks changed tests
- [ ] Test validator flags suspicious tests
- [ ] Doctor validator assesses effectiveness
- [ ] Validation failure prevents auto-merge

## CLI
- [ ] plan command works
- [ ] run command works
- [ ] resume command works
- [ ] status command works
- [ ] logs command works
- [ ] clean command works
```

---

### 2. Integration Tests

Automated tests that run the system end-to-end on a test repository.

```typescript
// tests/integration/full-run.test.ts

describe("Full orchestrator run", () => {
  const testRepo = setupTestRepo();  // Creates a small test project
  
  test("plan command generates valid manifests", async () => {
    await exec("task-orchestrator plan --project test-project --input plan.md");
    
    const manifests = glob(".tasks/*/manifest.json");
    expect(manifests.length).toBeGreaterThan(0);
    
    for (const m of manifests) {
      const manifest = JSON.parse(readFileSync(m));
      expect(manifest).toMatchSchema(manifestSchema);
    }
  });
  
  test("run command executes tasks in parallel batches", async () => {
    await exec("task-orchestrator run --project test-project");
    
    const state = loadState("test-project");
    expect(state.status).toBe("complete");
    expect(state.tasks).toAllSatisfy(t => t.status === "complete");
  });
  
  test("resume continues after simulated crash", async () => {
    // Start run
    const proc = spawn("task-orchestrator", ["run", "--project", "test-project"]);
    
    // Wait for first task to start
    await waitForLog("task.start");
    
    // Kill it
    proc.kill("SIGKILL");
    
    // Resume
    await exec("task-orchestrator resume --project test-project");
    
    // Should complete
    const state = loadState("test-project");
    expect(state.status).toBe("complete");
  });
  
  test("resource locks prevent conflicting parallel execution", async () => {
    // Setup: two tasks that both write to same resource
    setupConflictingTasks();
    
    await exec("task-orchestrator run --project test-project");
    
    const logs = loadLogs("test-project");
    const batch1Tasks = logs.filter(e => e.type === "batch.start" && e.batch_id === 1)[0].tasks;
    const batch2Tasks = logs.filter(e => e.type === "batch.start" && e.batch_id === 2)[0].tasks;
    
    // Conflicting tasks should be in different batches
    expect(batch1Tasks).not.toContain(batch2Tasks[0]);
  });
});
```

---

### 3. Contract Tests

Verify each component meets its interface contract.

```typescript
// tests/contracts/planner.test.ts

describe("Planner contract", () => {
  test("returns valid task array", async () => {
    const result = await planner.run(testPlan, testConfig);
    
    expect(result.tasks).toBeArray();
    expect(result.tasks.length).toBeGreaterThan(0);
  });
  
  test("each task has required fields", async () => {
    const result = await planner.run(testPlan, testConfig);
    
    for (const task of result.tasks) {
      expect(task.id).toMatch(/^\d{3}$/);
      expect(task.name).toMatch(/^[a-z0-9-]+$/);
      expect(task.locks).toHaveProperty("reads");
      expect(task.locks).toHaveProperty("writes");
      expect(task.files).toHaveProperty("reads");
      expect(task.files).toHaveProperty("writes");
      expect(task.spec).toBeTruthy();
    }
  });
  
  test("locks reference only defined resources", async () => {
    const result = await planner.run(testPlan, testConfig);
    const validResources = testConfig.resources.map(r => r.name);
    
    for (const task of result.tasks) {
      for (const r of [...task.locks.reads, ...task.locks.writes]) {
        expect(validResources).toContain(r);
      }
    }
  });
});
```

---

### 4. Log Schema Validation

Every log event must conform to its schema.

```typescript
// tests/logging/schema.test.ts

describe("Log event schemas", () => {
  const eventSchemas = {
    "run.start": z.object({
      ts: z.string().datetime(),
      type: z.literal("run.start"),
      run_id: z.string(),
      project: z.string(),
      total_tasks: z.number(),
    }),
    "task.start": z.object({
      ts: z.string().datetime(),
      type: z.literal("task.start"),
      task_id: z.string(),
      branch: z.string(),
      container_id: z.string(),
    }),
    // ... all event types
  };
  
  test("all emitted events match schema", async () => {
    await exec("task-orchestrator run --project test-project");
    
    const logs = readLogs("test-project");
    
    for (const event of logs) {
      const schema = eventSchemas[event.type];
      expect(schema).toBeDefined();
      expect(() => schema.parse(event)).not.toThrow();
    }
  });
});
```

---

### 5. Chaos Tests

Verify recovery from failures.

```typescript
// tests/chaos/recovery.test.ts

describe("Failure recovery", () => {
  test("survives orchestrator kill", async () => {
    // Tested above
  });
  
  test("survives Docker crash", async () => {
    const proc = spawn("task-orchestrator", ["run", "--project", "test-project"]);
    
    await waitForLog("container.start");
    
    // Kill the container externally
    const containerId = getRunningContainerId();
    await exec(`docker kill ${containerId}`);
    
    // Orchestrator should detect and restart
    await waitForLog("container.restart");
    
    // Should eventually complete
    await waitForCompletion(proc);
    
    const state = loadState("test-project");
    expect(state.status).toBe("complete");
  });
  
  test("handles doctor timeout", async () => {
    // Setup task with slow doctor
    setupSlowDoctorTask();
    
    await exec("task-orchestrator run --project test-project");
    
    const logs = loadLogs("test-project");
    expect(logs).toContainEvent({ type: "doctor.timeout" });
    expect(logs).toContainEvent({ type: "task.retry" });
  });
});
```

---

### 6. Spec Traceability Matrix

A document mapping every spec requirement to its test.

```markdown
# Traceability Matrix

| Spec Section | Requirement | Test File | Test Name |
|--------------|-------------|-----------|-----------|
| 4.1 | Orchestrator manages execution | integration/full-run.test.ts | run command executes tasks |
| 4.2 | Planner outputs structured JSON | contracts/planner.test.ts | returns valid task array |
| 4.3 | Worker uses runStreamed() | contracts/worker.test.ts | streams codex events |
| 6.4 | Lock scheduling rules | integration/full-run.test.ts | resource locks prevent conflicts |
| 8.2 | Event types logged | logging/schema.test.ts | all emitted events match schema |
| 13.3 | Container crash recovery | chaos/recovery.test.ts | survives Docker crash |
| ... | ... | ... | ... |
```

---

### 7. Manual Verification Protocol

For things that can't be easily automated:

```markdown
# Manual Verification Protocol

## Before Release

1. [ ] Run full integration test suite
2. [ ] Execute on real project (not test repo)
3. [ ] Let run for 2+ hours unattended
4. [ ] Manually inspect:
   - [ ] Log files are readable and complete
   - [ ] Git branches created correctly
   - [ ] Merges happened correctly
   - [ ] State file accurate
5. [ ] Simulate crash mid-run, verify resume
6. [ ] Review generated code quality
7. [ ] Check token usage is reasonable

## Sign-off

- Integration tests: PASS / FAIL
- Real project test: PASS / FAIL
- Crash recovery test: PASS / FAIL
- Code review: APPROVED / NEEDS WORK

Verified by: _______________
Date: _______________
```

---

## How to Use This

1. **During development:** Use the compliance checklist. Check items as you implement.

2. **Before PR:** Run the integration and contract tests.

3. **Before release:** Complete manual verification protocol.

4. **Ongoing:** Traceability matrix ensures spec changes get corresponding test changes.
