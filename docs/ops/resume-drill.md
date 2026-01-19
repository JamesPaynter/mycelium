# Resume drill (reattach + thread resume)

Proves that `resume` can recover from an orchestrator crash while the worker container keeps running and that the worker resumes the same Codex thread.

## Quick automation
- `RUN_DOCKER_TESTS=1 npm test -- src/__tests__/resume-drill.test.ts`
  - Uses the toy fixture in Docker, kills the orchestrator after `container.start`, runs `resume`, and asserts `container.reattach` + `codex.thread.resumed` + run `complete`.

## Manual drill (toy fixture)
1) **Prep**
   - Docker running.
   - `export MYCELIUM_HOME=/tmp/resume-drill-home`
   - `export MOCK_LLM=1`
   - `export MOCK_LLM_OUTPUT_PATH=$(pwd)/test/fixtures/toy-repo/mock-planner-output.json`
2) **Create repo copy**
   - `WORKDIR=$(mktemp -d /tmp/resume-drill-XXXX)`
   - `cp -r test/fixtures/toy-repo "$WORKDIR/repo"`
   - Add helpers inside `$WORKDIR/repo`:
     - `bootstrap-delay.js`
       ```js
       const delayMs = 4000;
       await new Promise((resolve) => setTimeout(resolve, delayMs));
       console.log(`bootstrap delay complete (${delayMs}ms)`);
       ```
     - `resume-doctor.js`
       ```js
       import fs from "node:fs";
       import path from "node:path";
       import { spawnSync } from "node:child_process";

       const guardPath =
         process.env.WORKER_FAIL_ONCE_FILE ??
         path.join(process.cwd(), ".mycelium", "codex-home", ".fail-once");
       if (!fs.existsSync(guardPath)) {
         fs.mkdirSync(path.dirname(guardPath), { recursive: true });
         fs.writeFileSync(guardPath, "fail-once", "utf8");
         console.error("resume doctor: intentional first-attempt failure");
         process.exit(1);
       }

       const doctorPath = path.join(process.cwd(), "doctor.js");
       const result = spawnSync(process.execPath, [doctorPath], { stdio: "inherit" });
       process.exit(result.status ?? 1);
       ```
   - Git init + commit (tree must be clean): `git init && git add -A && git commit -m "init" && git checkout -B main`
3) **Write config** (`$WORKDIR/project.yaml`)
   ```yaml
   repo_path: $WORKDIR/repo
   main_branch: main
   tasks_dir: .mycelium/tasks
   doctor: node resume-doctor.js
   max_parallel: 1
   resources:
     - name: docs
       paths: ["notes/**"]
     - name: code
       paths: ["src/**"]
   planner:
     provider: mock
     model: mock
   worker:
     model: mock
     checkpoint_commits: true
   bootstrap:
     - "node bootstrap-delay.js"
   docker:
     image: mycelium-worker:resume-drill
     dockerfile: <repo>/templates/Dockerfile
     build_context: <repo>
   ```
4) **Plan**: `npm run dev -- --config $WORKDIR/project.yaml plan --project resume-drill --input .mycelium/planning/implementation-plan.md`
5) **Start run**: `npm run dev -- --config $WORKDIR/project.yaml run --project resume-drill --run-id <id> --tasks 001 --max-parallel 1`
6) **Crash orchestrator**: watch `$MYCELIUM_HOME/logs/resume-drill/run-<id>/orchestrator.jsonl` for `container.start`, note PID, then `kill -9 <pid>` (container keeps running).
7) **Resume**: `npm run dev -- --config $WORKDIR/project.yaml resume --project resume-drill --run-id <id> --max-parallel 1 --no-build-image`
8) **Verify**
   - `grep container.reattach $MYCELIUM_HOME/logs/resume-drill/run-<id>/orchestrator.jsonl`
   - `grep codex.thread.resumed $MYCELIUM_HOME/logs/resume-drill/run-<id>/task-*/events.jsonl`
   - `jq '.status' $MYCELIUM_HOME/state/resume-drill/run-<id>.json` → `complete`

## Expected artifacts
- JSONL logs containing `container.reattach` and `codex.thread.resumed`
- Run state JSON with `status: "complete"`
- Worker events showing the resumed thread id (mock)
