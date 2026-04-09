/**
 * @process generic/bug-hunter
 * @description Generic bug hunter: scan any repo with parallel agents, weighted expert voting verification (3 specialist judges with domain-weighted confidence scoring and expert veto), dedup, prove, fix (max 8/batch), fix-confidence scoring with convergence loop, regression check, hard build gate, commit with bug IDs, re-scan modified files only until done.
 * @inputs { projectDir: string, buildCmd?: string, testCmd?: string, maxIterations?: number, categories?: string[], maxBatchSize?: number, autoFix?: boolean, fixConfidenceTarget?: number, maxFixAttempts?: number }
 * @outputs { success: boolean, totalFound: number, falsePositives: number, needsAttention: number, verified: number, fixed: number, remaining: number, iterations: number, fixConfidenceScores: object[] }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

const ALL_CATEGORIES = ['logic', 'security', 'memory-lifecycle', 'error-handling', 'performance', 'thread-safety'];
const DEFAULT_MAX_BATCH = 8;
const DEFAULT_FIX_CONFIDENCE_TARGET = 85;
const DEFAULT_MAX_FIX_ATTEMPTS = 3;

// ==========================================================================
// MAIN PROCESS
// ==========================================================================

export async function process(inputs, ctx) {
  const {
    projectDir,
    buildCmd: buildCmdOverride,
    testCmd: testCmdOverride,
    maxIterations = 5,
    categories = ALL_CATEGORIES,
    maxBatchSize = DEFAULT_MAX_BATCH,
    autoFix = true,
    fixConfidenceTarget = DEFAULT_FIX_CONFIDENCE_TARGET,
    maxFixAttempts = DEFAULT_MAX_FIX_ATTEMPTS,
  } = inputs;

  if (!projectDir) throw new Error('projectDir is required');

  // --- Phase 1: Detect project ---
  const projectInfo = await ctx.task(detectProjectTask, { projectDir, buildCmdOverride, testCmdOverride });
  const { buildCmd, testCmd, srcDirs } = projectInfo;

  let allFixedBugs = [];
  let allFalsePositives = [];
  let allNeedsAttention = [];
  let allFixConfidenceScores = [];
  let totalFound = 0;
  let iteration = 0;
  let modifiedFiles = [];

  for (iteration = 1; iteration <= maxIterations; iteration++) {
    // --- Phase 2: Scan for bugs (ALL CATEGORIES IN PARALLEL) ---
    const scanResults = await ctx.parallel.map(categories, (category) =>
      ctx.task(scanBugsTask, {
        projectDir, srcDirs, category, iteration,
        scopeToFiles: iteration > 1 ? modifiedFiles : null,
      })
    );

    const rawFindings = scanResults.flat();
    if (rawFindings.length === 0) break;

    // --- Phase 2.5: Deduplicate findings by file+line ---
    const dedupResult = await ctx.task(deduplicateFindingsTask, { findings: rawFindings });
    const allFindings = dedupResult.unique || rawFindings;
    const duplicatesRemoved = dedupResult.duplicatesRemoved || 0;

    totalFound += allFindings.length;

    // --- Phase 3: Verify all findings with weighted expert voting ---
    const verificationResult = await ctx.task(verifyAllFindingsTask, { projectDir, findings: allFindings, categories });
    const verifiedFindings = verificationResult.verified || [];
    const needsAttentionFindings = verificationResult.needsAttention || [];
    const falsePositives = verificationResult.dismissed || [];

    allFalsePositives.push(...falsePositives);
    allNeedsAttention.push(...needsAttentionFindings);

    if (verifiedFindings.length === 0) break;

    // --- Phase 4: Triage — sort by severity ---
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    verifiedFindings.sort((a, b) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99));

    // --- Phase 5: Prove all bugs ---
    const proveResult = await ctx.task(proveAllBugsTask, { projectDir, bugs: verifiedFindings, testCmd });
    const provenBugs = proveResult.proven || [];
    const unproven = proveResult.unproven || [];
    allFalsePositives.push(...unproven.map(b => ({ ...b, reason: 'could not prove' })));

    if (provenBugs.length === 0) break;

    // --- Breakpoint: Review findings before fixing (interactive mode) ---
    if (!autoFix) {
      const reviewSummary = provenBugs.map(b => `[${b.severity}] ${b.id}: ${b.file} — ${b.title}`).join('\n');
      await ctx.breakpoint(`Found ${provenBugs.length} verified bugs to fix:\n\n${reviewSummary}\n\nProceed with fixes?`);
    }

    // --- Phase 6: Fix in batches by severity, max N per batch ---
    const batches = groupBySeverity(provenBugs, maxBatchSize);
    modifiedFiles = [];

    for (const batch of batches) {
      // Breakpoint: Review each batch before fixing (interactive mode)
      if (!autoFix) {
        const batchSummary = batch.bugs.map(b => `  ${b.id}: ${b.file}:${b.line} — ${b.title}`).join('\n');
        await ctx.breakpoint(`About to fix ${batch.bugs.length} ${batch.severity}-severity bugs:\n\n${batchSummary}\n\nProceed?`);
      }

      // --- Fix with confidence scoring convergence loop ---
      let fixAttempt = 0;
      let fixResult = null;
      let confidenceResult = null;
      let batchConverged = false;

      while (fixAttempt < maxFixAttempts && !batchConverged) {
        fixAttempt++;

        // Fix (or re-fix with previous feedback)
        fixResult = await ctx.task(fixBatchTask, {
          projectDir,
          bugs: batch.bugs,
          severity: batch.severity,
          attempt: fixAttempt,
          previousFeedback: confidenceResult?.lowConfidenceFixes || null,
        });

        // Score fix confidence — did each fix actually address the root cause?
        confidenceResult = await ctx.task(fixConfidenceScoringTask, {
          projectDir,
          bugs: batch.bugs,
          fixResult,
          attempt: fixAttempt,
          targetConfidence: fixConfidenceTarget,
        });

        allFixConfidenceScores.push({
          batch: `${batch.severity}-${batches.indexOf(batch)}`,
          attempt: fixAttempt,
          overallConfidence: confidenceResult.overallConfidence,
          perBugScores: confidenceResult.perBugScores,
        });

        if (confidenceResult.overallConfidence >= fixConfidenceTarget) {
          batchConverged = true;
        } else if (fixAttempt < maxFixAttempts) {
          // Check for plateau — if improvement < 5 points, breakpoint
          if (fixAttempt >= 2) {
            const prevScore = allFixConfidenceScores[allFixConfidenceScores.length - 2]?.overallConfidence || 0;
            const improvement = confidenceResult.overallConfidence - prevScore;
            if (improvement < 5) {
              if (!autoFix) {
                await ctx.breakpoint(
                  `Fix confidence plateaued at ${confidenceResult.overallConfidence}/${fixConfidenceTarget} ` +
                  `(+${improvement} from last attempt). Continue refining or accept current fixes?`
                );
              }
              // In yolo mode, accept plateau and move on
              batchConverged = true;
            }
          }
        }
      }

      // Regression check + compile gate in parallel
      const [regressionResult, lintResult] = await ctx.parallel.all([
        () => ctx.task(regressionCheckTask, {
          projectDir,
          filesModified: fixResult.filesModified || [],
          bugsFixed: fixResult.bugsFixed || [],
        }),
        buildCmd ? () => ctx.task(compileGateTask, { projectDir, buildCmd }) : () => Promise.resolve({ success: true }),
      ]);

      // If regressions found, fix them before full build
      if (regressionResult.regressionsFound && regressionResult.regressions?.length > 0) {
        await ctx.task(fixRegressionTask, {
          projectDir,
          regressions: regressionResult.regressions,
          originalFixes: fixResult.bugsFixed || [],
        });
      }

      // Full build + test (hard shell gate)
      const buildResult = await ctx.task(buildTestTask, { projectDir, buildCmd, testCmd, batchName: `${batch.severity} fixes` });

      // If build failed, attempt correction then retry
      if (!buildResult.buildSuccess) {
        await ctx.task(fixBuildErrorsTask, { projectDir, errors: buildResult.errors, buildCmd, testCmd });
        const retryBuild = await ctx.task(buildTestTask, { projectDir, buildCmd, testCmd, batchName: `${batch.severity} fixes (retry)` });
        if (!retryBuild.buildSuccess) {
          await ctx.breakpoint(`Build failed after fixing ${batch.severity} bugs. Errors:\n${JSON.stringify(retryBuild.errors, null, 2)}\n\nManual intervention required. Continue anyway?`);
        }
      }

      // Breakpoint: Review changes before committing (interactive mode)
      if (!autoFix) {
        await ctx.breakpoint(
          `Build passed for ${batch.severity} fixes. ` +
          `Fix confidence: ${confidenceResult.overallConfidence}/${fixConfidenceTarget} (${fixAttempt} attempt${fixAttempt > 1 ? 's' : ''}). ` +
          `Commit these changes?`
        );
      }

      // Commit with bug IDs
      const bugIds = (fixResult.bugsFixed || batch.bugs.map(b => b.id));
      await ctx.task(commitBatchTask, { projectDir, severity: batch.severity, fixResult, bugIds });

      // Track modified files for scoped re-scan
      modifiedFiles.push(...(fixResult.filesModified || []));
      allFixedBugs.push(...batch.bugs);
    }

    // Deduplicate modified files list
    modifiedFiles = [...new Set(modifiedFiles)];
  }

  // --- Final report ---
  const avgConfidence = allFixConfidenceScores.length > 0
    ? Math.round(allFixConfidenceScores.reduce((sum, s) => sum + s.overallConfidence, 0) / allFixConfidenceScores.length)
    : null;

  const report = await ctx.task(finalReportTask, {
    projectDir,
    totalFound,
    falsePositives: allFalsePositives.length,
    needsAttention: allNeedsAttention.length,
    verified: totalFound - allFalsePositives.length - allNeedsAttention.length,
    fixed: allFixedBugs.length,
    remaining: (totalFound - allFalsePositives.length - allNeedsAttention.length) - allFixedBugs.length,
    iterations: iteration,
    fixedBugs: allFixedBugs,
    falsePositivesList: allFalsePositives,
    needsAttentionList: allNeedsAttention,
    fixConfidenceScores: allFixConfidenceScores,
    avgFixConfidence: avgConfidence,
    fixConfidenceTarget,
  });

  return {
    success: true,
    totalFound,
    falsePositives: allFalsePositives.length,
    needsAttention: allNeedsAttention.length,
    verified: totalFound - allFalsePositives.length - allNeedsAttention.length,
    fixed: allFixedBugs.length,
    remaining: (totalFound - allFalsePositives.length - allNeedsAttention.length) - allFixedBugs.length,
    iterations: iteration,
    fixConfidenceScores: allFixConfidenceScores,
    avgFixConfidence: avgConfidence,
  };
}

// ==========================================================================
// HELPERS
// ==========================================================================

function groupBySeverity(bugs, maxBatchSize) {
  const groups = {};
  for (const bug of bugs) {
    const sev = bug.severity || 'medium';
    if (!groups[sev]) groups[sev] = [];
    groups[sev].push(bug);
  }
  const order = ['critical', 'high', 'medium', 'low'];
  const batches = [];
  for (const sev of order) {
    if (!groups[sev]?.length) continue;
    const sorted = groups[sev].sort((a, b) => (a.file || '').localeCompare(b.file || ''));
    for (let i = 0; i < sorted.length; i += maxBatchSize) {
      batches.push({ severity: sev, bugs: sorted.slice(i, i + maxBatchSize) });
    }
  }
  return batches;
}

// ==========================================================================
// TASK DEFINITIONS
// ==========================================================================

export const detectProjectTask = defineTask('detect-project', (args) => ({
  kind: 'agent',
  title: 'Detect project language, build, and test commands',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'DevOps engineer analyzing a repository',
      task: `Detect the project type, language, framework, build command, test command, and source directories for the repo at ${args.projectDir}.`,
      instructions: [
        `Read the repo root at ${args.projectDir}. Look for:`,
        '- package.json (Node.js/JS/TS) -> npm/yarn/pnpm build/test',
        '- build.gradle or build.gradle.kts (Android/Java/Kotlin) -> ./gradlew assembleDebug / ./gradlew test',
        '- Cargo.toml (Rust) -> cargo build / cargo test',
        '- go.mod (Go) -> go build ./... / go test ./...',
        '- pyproject.toml or setup.py (Python) -> pip install / pytest',
        '- Makefile -> make / make test',
        '- CMakeLists.txt (C/C++) -> cmake --build / ctest',
        '',
        'Also identify the main source directories (e.g., src/, app/src/main/, lib/).',
        '',
        args.buildCmdOverride ? `User override for buildCmd: ${args.buildCmdOverride}` : 'No buildCmd override — auto-detect.',
        args.testCmdOverride ? `User override for testCmd: ${args.testCmdOverride}` : 'No testCmd override — auto-detect. If no test framework found, set testCmd to null.',
        '',
        'IMPORTANT: You are executing a SINGLE TASK in a babysitter-orchestrated pipeline.',
        'Do ONLY project detection. Do NOT scan for bugs, fix code, or do anything beyond detection.',
        'Return ONLY JSON:',
        '{"language": "...", "framework": "...", "buildCmd": "...", "testCmd": "..." or null, "srcDirs": ["..."], "testDirs": ["..."]}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

const CATEGORY_PROMPTS = {
  'logic': {
    title: 'Logic bugs',
    description: 'Dead code paths, unreachable branches, off-by-one errors, null pointer dereferences, incorrect conditionals, missing return values, wrong operator usage, infinite loops, incorrect type coercions',
  },
  'security': {
    title: 'Security vulnerabilities',
    description: 'Injection (SQL, command, XSS), leaked secrets/API keys in code or logs, insecure storage, missing input validation, missing auth checks, insecure crypto, hardcoded credentials, path traversal',
  },
  'memory-lifecycle': {
    title: 'Memory and lifecycle bugs',
    description: 'Memory leaks, unclosed resources (streams, connections, cursors), missing cleanup in destructors/dispose/onDestroy, context leaks (Android), dangling references, circular references preventing GC',
  },
  'error-handling': {
    title: 'Error handling bugs',
    description: 'Swallowed exceptions (empty catch blocks), missing error propagation, missing fallbacks for nullable returns, unhandled promise rejections, crash paths from uncaught exceptions, incorrect error types',
  },
  'performance': {
    title: 'Performance bugs',
    description: 'Unnecessary object allocations in hot paths, blocking main/UI thread with IO or computation, N+1 query patterns, redundant re-renders, missing caching for expensive operations, unbounded collection growth',
  },
  'thread-safety': {
    title: 'Thread safety bugs',
    description: 'Missing synchronization on shared mutable state, race conditions, non-atomic check-then-act patterns, unsafe lazy initialization, deadlock potential, incorrect volatile/atomic usage, thread-unsafe collections',
  },
};

export const scanBugsTask = defineTask('scan-bugs', (args) => ({
  kind: 'agent',
  title: `Scan: ${CATEGORY_PROMPTS[args.category]?.title || args.category} (iteration ${args.iteration})`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: `Senior software engineer specializing in ${CATEGORY_PROMPTS[args.category]?.title || args.category} detection`,
      task: `Scan the codebase at ${args.projectDir} for ${CATEGORY_PROMPTS[args.category]?.title || args.category}.`,
      instructions: [
        `You are scanning for: ${CATEGORY_PROMPTS[args.category]?.description || args.category}`,
        '',
        `Source directories to scan: ${JSON.stringify(args.srcDirs || [])}`,
        `Project root: ${args.projectDir}`,
        '',
        ...(args.scopeToFiles?.length > 0 ? [
          'IMPORTANT: This is a RE-SCAN after fixes. Only scan these modified files for NEW bugs or regressions:',
          JSON.stringify(args.scopeToFiles),
          'Do NOT re-report previously fixed bugs. Focus on bugs introduced by recent changes.',
          '',
        ] : []),
        'INSTRUCTIONS:',
        args.scopeToFiles?.length > 0
          ? '1. Read only the modified files listed above.'
          : '1. Read every source file in the source directories.',
        '2. For each potential bug, record it with exact file path and line number.',
        '3. Assign severity: critical, high, medium, or low.',
        '4. Be thorough but precise — report only things that are actually likely bugs, not style preferences.',
        '5. Do NOT report: style issues, naming conventions, missing comments, missing types/annotations, formatting.',
        '6. DO report: actual bugs that could cause crashes, data loss, security issues, or incorrect behavior.',
        '',
        'IMPORTANT: You are executing a SINGLE TASK in a babysitter-orchestrated pipeline.',
        'Do ONLY scanning. Do NOT fix bugs, verify findings, or do anything beyond scanning.',
        'Babysitter will dispatch separate verification and fix tasks after this.',
        '',
        'Return ONLY a JSON array:',
        '[{"id": "category-N", "file": "path/to/file.ext", "line": N, "category": "' + args.category + '", "severity": "critical|high|medium|low", "title": "short title", "description": "detailed description of the bug and why it matters"}]',
        '',
        'Return [] if no bugs found.',
      ],
      outputFormat: 'JSON array',
    },
  },
}));

export const deduplicateFindingsTask = defineTask('deduplicate-findings', (args) => ({
  kind: 'agent',
  title: `Deduplicate ${args.findings.length} findings`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior engineer deduplicating bug reports',
      task: `Deduplicate ${args.findings.length} bug findings. Merge findings that refer to the same underlying issue (same file+line or same root cause).`,
      instructions: [
        'You have findings from multiple category scanners that may overlap.',
        'Two findings are duplicates if they:',
        '- Point to the same file and same/adjacent lines AND describe the same underlying issue',
        '- Describe the same root cause from different category perspectives (e.g., a race condition reported as both "logic" and "thread-safety")',
        '',
        'When merging duplicates:',
        '- Keep the one with the highest severity',
        '- Combine categories into a comma-separated list (e.g., "logic, thread-safety")',
        '- Use the most descriptive title and description',
        '',
        'IMPORTANT: You are executing a SINGLE TASK in a babysitter-orchestrated pipeline.',
        'Do ONLY deduplication. Do NOT verify, fix, or take any other action.',
        '',
        'FINDINGS:',
        JSON.stringify(args.findings, null, 2),
        '',
        'Return ONLY JSON:',
        '{"unique": [<deduplicated findings array>], "duplicatesRemoved": <count of duplicates removed>, "mergeLog": [<"merged X into Y" descriptions>]}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

const CATEGORY_TO_EXPERT = {
  'logic': 'software-engineer',
  'security': 'security-specialist',
  'memory-lifecycle': 'systems-engineer',
  'error-handling': 'software-engineer',
  'performance': 'systems-engineer',
  'thread-safety': 'systems-engineer',
  'sql-logic': 'data-engineer',
  'data-integrity': 'data-engineer',
  'resource-config': 'systems-engineer',
  'pipeline-logic': 'pipeline-architect',
  'test-gaps': 'software-engineer',
  'conventions': 'software-engineer',
  'contract-drift': 'software-engineer',
};

const EXPERT_WEIGHT_MULTIPLIER = 2;
const VERIFIED_THRESHOLD = 50;
const NEEDS_ATTENTION_THRESHOLD = 30;
const EXPERT_VETO_THRESHOLD = 80;

export const verifyAllFindingsTask = defineTask('verify-all-findings', (args) => ({
  kind: 'agent',
  title: `Verify ${args.findings.length} findings with weighted expert voting (3 specialist judges)`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Panel of 3 specialist judges performing weighted expert voting on bug verification',
      task: `For each of the ${args.findings.length} reported bugs, evaluate using 3 specialist judges with weighted confidence scoring. Each judge scores their confidence (0-100) that each finding is a real bug. The domain expert for each finding's category gets double weight.`,
      instructions: [
        'You are simulating a panel of 3 SPECIALIST judges, each with a distinct expertise:',
        '',
        'JUDGE 1 — Software Engineer:',
        '  Focus: code correctness, logic errors, edge cases, error handling, test coverage gaps',
        '  Expert categories: logic, error-handling, test-gaps, conventions, contract-drift',
        '',
        'JUDGE 2 — Data/Infrastructure Engineer:',
        '  Focus: data integrity, SQL correctness, pipeline dependencies, resource configuration',
        '  Expert categories: sql-logic, data-integrity, resource-config, pipeline-logic',
        '',
        'JUDGE 3 — Security & Systems Specialist:',
        '  Focus: security vulnerabilities, memory safety, concurrency, performance bottlenecks',
        '  Expert categories: security, memory-lifecycle, performance, thread-safety',
        '',
        'FOR EACH FINDING:',
        '1. Read the actual source file at the reported location',
        '2. Each judge independently scores their CONFIDENCE (0-100) that this is a real bug',
        '3. The judge whose expertise matches the finding category gets DOUBLE WEIGHT (×2)',
        '4. Compute weighted average: sum(score × weight) / sum(weights)',
        '',
        'CLASSIFICATION RULES:',
        `- Expert Veto: If the domain expert scores ≥${EXPERT_VETO_THRESHOLD}, the finding is VERIFIED regardless of other scores`,
        `- Weighted average ≥${VERIFIED_THRESHOLD}: VERIFIED`,
        `- Weighted average ${NEEDS_ATTENTION_THRESHOLD}-${VERIFIED_THRESHOLD - 1}: NEEDS ATTENTION (borderline — include expert reasoning)`,
        `- Weighted average <${NEEDS_ATTENTION_THRESHOLD}: DISMISSED`,
        '',
        'Category-to-expert mapping:',
        JSON.stringify(CATEGORY_TO_EXPERT, null, 2),
        '',
        `Project root: ${args.projectDir}`,
        '',
        'BE SKEPTICAL. Many findings are false positives because:',
        '- The issue is handled by a caller or wrapper',
        '- The code path is unreachable in practice',
        '- The framework/language provides built-in safety',
        '- The "bug" is actually intentional behavior',
        '- The finding is a style preference, not a bug',
        '',
        'REQUIRE 2+ INDEPENDENT EVIDENCE SIGNALS per verified finding:',
        '- Evidence from reading the code at the reported location',
        '- Evidence from reading callers/consumers of the code',
        '- Evidence from framework documentation or language spec',
        '- Evidence from test coverage (or lack thereof)',
        'A single "the code looks wrong" is NOT sufficient.',
        '',
        'FINDINGS TO VERIFY:',
        JSON.stringify(args.findings, null, 2),
        '',
        'For each finding, read the source file and evaluate.',
        '',
        'IMPORTANT: You are executing a SINGLE TASK in a babysitter-orchestrated pipeline.',
        'Do ONLY verification. Do NOT fix bugs or take any other action.',
        '',
        'Return ONLY JSON (no markdown):',
        '{',
        '  "verified": [<findings with weightedAverage >= 50 OR expert veto, with added fields: "judgeScores": {"softwareEngineer": N, "dataEngineer": N, "securitySpecialist": N}, "expertJudge": "which judge is expert", "weightedAverage": N, "expertVeto": bool, "evidence": "...">],',
        '  "needsAttention": [<findings with weightedAverage 30-49, same fields plus "expertReasoning": "why the expert flagged this">],',
        '  "dismissed": [<findings with weightedAverage < 30, with "judgeScores" and "reason" fields>]',
        '}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

export const proveAllBugsTask = defineTask('prove-all-bugs', (args) => ({
  kind: 'agent',
  title: `Prove ${args.bugs.length} verified bugs`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer creating concrete proof for verified bugs',
      task: `For each of the ${args.bugs.length} verified bugs, determine if it can be proven with a concrete reproduction scenario.`,
      instructions: [
        `Project: ${args.projectDir}`,
        args.testCmd ? `Test command: ${args.testCmd}` : 'No test framework detected.',
        '',
        'For each bug, read the source file and determine:',
        '1. Can you trace a concrete code path that triggers this bug?',
        '2. What is the exact scenario (input/state) that causes the problem?',
        '3. What is the expected vs actual behavior?',
        '4. What are the edge cases and boundary conditions?',
        '',
        'A bug is PROVEN only if you can describe:',
        '- A specific input or state that triggers it',
        '- The exact code path that executes',
        '- The observable incorrect behavior',
        '',
        'If after investigation a bug turns out NOT to be real, mark it as unproven.',
        '',
        'IMPORTANT: You are executing a SINGLE TASK in a babysitter-orchestrated pipeline.',
        'Do ONLY proving. Do NOT fix bugs or take any other action.',
        '',
        'BUGS TO PROVE:',
        JSON.stringify(args.bugs, null, 2),
        '',
        'Return ONLY JSON (no markdown):',
        '{"proven": [<bugs with added "proof" field describing the repro scenario>], "unproven": [<bugs with added "reason" field>]}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

export const fixBatchTask = defineTask('fix-batch', (args) => ({
  kind: 'agent',
  title: `Fix ${args.severity} bugs (${args.bugs.length} issues)${args.attempt > 1 ? ` — attempt ${args.attempt}` : ''}`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior software engineer fixing verified and proven bugs',
      task: `Fix all ${args.severity}-severity verified bugs in ${args.projectDir}.${args.attempt > 1 ? ` This is attempt ${args.attempt} — previous fixes scored below confidence target.` : ''}`,
      instructions: [
        `Fix ALL ${args.bugs.length} bugs listed below. Read each file FULLY before editing. Make surgical edits — do not rewrite entire files.`,
        '',
        ...(args.previousFeedback?.length > 0 ? [
          'PREVIOUS FIX ATTEMPT FEEDBACK (address these issues):',
          ...args.previousFeedback.map(f =>
            `  - [${f.bugId}] Confidence: ${f.confidence}/100 — ${f.reason}`
          ),
          '',
          'Focus on the low-confidence fixes above. Re-read the code, re-read the proof,',
          'and ensure your fix addresses the ACTUAL root cause, not just the symptom.',
          '',
        ] : []),
        'BUGS TO FIX:',
        ...args.bugs.map((b, i) =>
          `${i + 1}. [${b.id}] [${b.category}] ${b.file}:${b.line} — ${b.title}\n   ${b.description}\n   Proof: ${b.proof || 'N/A'}`
        ),
        '',
        'RULES:',
        '- Fix only the reported bug, do not refactor surrounding code',
        '- Preserve existing code style and conventions',
        '- If a fix requires adding an import, add it',
        '- If a fix could break callers, note it in the response',
        '- Do NOT add comments explaining the fix unless the logic is non-obvious',
        '',
        'IMPORTANT: You are executing a SINGLE TASK in a babysitter-orchestrated pipeline.',
        'Do ONLY fixing. Do NOT run builds, commit, or take any other action.',
        'Babysitter will dispatch separate confidence scoring, regression check, and build tasks after this.',
        '',
        'Return ONLY JSON:',
        '{"filesModified": ["..."], "fixesMade": ["short description per fix"], "bugsFixed": ["bug ids"]}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

// Fix confidence scoring — scores whether each fix addresses the proven root cause
export const fixConfidenceScoringTask = defineTask('fix-confidence-scoring', (args) => ({
  kind: 'agent',
  title: `Score fix confidence (attempt ${args.attempt}): ${args.bugs.length} fixes, target ${args.targetConfidence}`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior QA engineer and code reviewer evaluating fix correctness',
      task: `Score the confidence that each bug fix actually addresses the proven root cause. Target: ${args.targetConfidence}/100.`,
      instructions: [
        `Project: ${args.projectDir}`,
        `Attempt: ${args.attempt}`,
        `Target confidence: ${args.targetConfidence}/100`,
        '',
        'FOR EACH BUG AND ITS FIX, evaluate across 4 dimensions:',
        '',
        '1. ROOT CAUSE MATCH (weight: 40%)',
        '   Does the fix address the exact root cause described in the proof?',
        '   Or does it only address a symptom / a different issue?',
        '   Score 0-100.',
        '',
        '2. COMPLETENESS (weight: 25%)',
        '   Does the fix handle all code paths where the bug manifests?',
        '   Are there other call sites / similar patterns left unfixed?',
        '   Score 0-100.',
        '',
        '3. CORRECTNESS (weight: 20%)',
        '   Is the fix itself correct? No new logic errors?',
        '   Does it preserve existing behavior for non-buggy cases?',
        '   Score 0-100.',
        '',
        '4. SAFETY (weight: 15%)',
        '   Could the fix break callers or change public API behavior?',
        '   Does it introduce any new risk?',
        '   Score 0-100.',
        '',
        'BUGS AND THEIR FIXES:',
        ...args.bugs.map((b, i) => [
          `Bug ${i + 1}: [${b.id}] ${b.file}:${b.line} — ${b.title}`,
          `  Description: ${b.description}`,
          `  Proof: ${b.proof || 'N/A'}`,
          `  Fix applied: ${(args.fixResult.fixesMade || [])[i] || 'see modified files'}`,
        ].join('\n')),
        '',
        'FILES MODIFIED:',
        JSON.stringify(args.fixResult.filesModified || []),
        '',
        'Read each modified file and the git diff to evaluate the fixes.',
        '',
        'IMPORTANT: You are executing a SINGLE TASK in a babysitter-orchestrated pipeline.',
        'Do ONLY scoring. Do NOT fix bugs or take any other action.',
        '',
        'Return ONLY JSON:',
        '{',
        '  "overallConfidence": <weighted average 0-100>,',
        '  "perBugScores": [',
        '    {',
        '      "bugId": "...",',
        '      "confidence": <weighted score 0-100>,',
        '      "rootCauseMatch": <0-100>,',
        '      "completeness": <0-100>,',
        '      "correctness": <0-100>,',
        '      "safety": <0-100>,',
        '      "verdict": "high-confidence|medium-confidence|low-confidence|needs-rework",',
        '      "reason": "brief explanation"',
        '    }',
        '  ],',
        '  "lowConfidenceFixes": [<bugs where confidence < target, with bugId, confidence, reason for feedback to next attempt>]',
        '}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

export const regressionCheckTask = defineTask('regression-check', (args) => ({
  kind: 'agent',
  title: `Regression check on ${args.filesModified?.length || 0} modified files`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior code reviewer checking for regressions introduced by bug fixes',
      task: 'Review the diff of recently modified files to check if the bug fixes introduced any new issues.',
      instructions: [
        `Project: ${args.projectDir}`,
        '',
        'FILES MODIFIED BY RECENT FIXES:',
        JSON.stringify(args.filesModified),
        '',
        'BUGS THAT WERE FIXED:',
        JSON.stringify(args.bugsFixed),
        '',
        'YOUR TASK:',
        '1. Run `git diff` on the modified files to see exactly what changed',
        '2. Read each modified file in full',
        '3. Look for issues INTRODUCED by the fixes:',
        '   - Missing null checks added by the fix',
        '   - Resource leaks in new code paths',
        '   - Changed method signatures that break callers',
        '   - Logic errors in the fix itself (e.g., wrong condition, off-by-one)',
        '   - Thread safety issues in new synchronization code',
        '4. Do NOT re-report the original bugs that were just fixed',
        '5. Only report issues that are clearly caused by the fix changes',
        '',
        'IMPORTANT: You are executing a SINGLE TASK in a babysitter-orchestrated pipeline.',
        'Do ONLY regression checking. Do NOT fix regressions or take any other action.',
        '',
        'Return ONLY JSON:',
        '{"regressionsFound": true/false, "regressions": [{"file": "...", "line": N, "title": "...", "description": "...", "causedBy": "which bug fix caused this"}]}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

export const fixRegressionTask = defineTask('fix-regression', (args) => ({
  kind: 'agent',
  title: `Fix ${args.regressions.length} regressions`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior developer fixing regressions introduced by bug fixes',
      task: `Fix regressions found in the recent bug fix batch.`,
      instructions: [
        `Project: ${args.projectDir}`,
        '',
        'REGRESSIONS TO FIX:',
        JSON.stringify(args.regressions, null, 2),
        '',
        'These were introduced by fixes for: ' + JSON.stringify(args.originalFixes),
        '',
        'Fix each regression without reverting the original bug fix.',
        'Make surgical edits only.',
        '',
        'IMPORTANT: You are executing a SINGLE TASK in a babysitter-orchestrated pipeline.',
        'Do ONLY regression fixing. Do NOT run builds, commit, or take any other action.',
        '',
        'Return ONLY JSON:',
        '{"filesModified": ["..."], "fixesMade": ["..."], "regressionsFixed": true}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

// Hard compile/lint gate — shell task, process FAILS on non-zero exit
export const compileGateTask = defineTask('compile-gate', (args) => ({
  kind: 'shell',
  title: `Compile gate: ${args.buildCmd}`,
  shell: {
    command: args.buildCmd,
    cwd: args.projectDir,
    timeout: 300000,
  },
}));

export const buildTestTask = defineTask('build-test', (args) => ({
  kind: 'shell',
  title: `Build + Test: ${args.batchName}`,
  shell: {
    command: [
      args.buildCmd,
      args.testCmd ? `&& ${args.testCmd}` : '',
    ].filter(Boolean).join(' '),
    cwd: args.projectDir,
    timeout: 600000,
  },
}));

export const fixBuildErrorsTask = defineTask('fix-build-errors', (args) => ({
  kind: 'agent',
  title: 'Fix build/test errors',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior developer fixing build errors',
      task: `The build or tests failed after applying bug fixes. Fix the errors.`,
      instructions: [
        `Project: ${args.projectDir}`,
        '',
        'BUILD/TEST ERRORS:',
        JSON.stringify(args.errors),
        '',
        'Fix the compilation or test errors caused by the bug fixes.',
        'Do NOT revert the bug fixes — fix them so they compile and tests pass.',
        '',
        `Verify with: ${args.buildCmd}`,
        args.testCmd ? `Then run: ${args.testCmd}` : '',
        '',
        'IMPORTANT: You are executing a SINGLE TASK in a babysitter-orchestrated pipeline.',
        'Do ONLY error fixing. Do NOT commit or take any other action.',
        '',
        'Return ONLY JSON:',
        '{"filesModified": ["..."], "fixesMade": ["..."], "buildSuccess": true/false}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

export const commitBatchTask = defineTask('commit-batch', (args) => ({
  kind: 'shell',
  title: `Commit: ${args.severity} fixes`,
  shell: {
    command: [
      `cd ${args.projectDir}`,
      `&& git add -A`,
      `&& git commit -m "fix(${args.severity}): [${(args.bugIds || []).join(', ')}] ${(args.fixResult?.fixesMade || []).slice(0, 3).join('; ').replace(/"/g, '\\"')}"`,
    ].join(' '),
    cwd: args.projectDir,
    timeout: 30000,
  },
}));

export const finalReportTask = defineTask('final-report', (args) => ({
  kind: 'agent',
  title: 'Generate final bug hunt report',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Technical writer summarizing a bug hunting session',
      task: 'Generate a concise final report of the bug hunting session.',
      instructions: [
        `Project: ${args.projectDir}`,
        `Iterations: ${args.iterations}`,
        `Total findings: ${args.totalFound}`,
        `Dismissed (false positives): ${args.falsePositives}`,
        `Needs attention (borderline): ${args.needsAttention || 0}`,
        `Verified bugs: ${args.verified}`,
        `Fixed: ${args.fixed}`,
        `Remaining: ${args.remaining}`,
        '',
        'FIXED BUGS:',
        JSON.stringify(args.fixedBugs?.map(b => ({ id: b.id, title: b.title, file: b.file, severity: b.severity, category: b.category })) || []),
        '',
        'NEEDS ATTENTION (borderline findings — expert flagged but below verification threshold):',
        JSON.stringify(args.needsAttentionList?.map(b => ({ id: b.id, title: b.title, file: b.file, category: b.category, weightedAverage: b.weightedAverage, expertJudge: b.expertJudge, expertReasoning: b.expertReasoning })) || []),
        '',
        'DISMISSED (false positives):',
        JSON.stringify(args.falsePositivesList?.map(b => ({ id: b.id, title: b.title, file: b.file, reason: b.reason })) || []),
        '',
        args.avgFixConfidence != null ? `Average fix confidence: ${args.avgFixConfidence}/100 (target: ${args.fixConfidenceTarget})` : '',
        '',
        'FIX CONFIDENCE SCORES:',
        JSON.stringify(args.fixConfidenceScores?.map(s => ({
          batch: s.batch,
          attempt: s.attempt,
          confidence: s.overallConfidence,
          perBug: s.perBugScores?.map(p => ({ bugId: p.bugId, confidence: p.confidence, verdict: p.verdict })),
        })) || []),
        '',
        'Write a clean markdown report with:',
        '1. Summary stats table (include avg fix confidence, needs-attention count)',
        '2. Fixed bugs grouped by severity with bug IDs and per-bug confidence scores',
        '3. Needs Attention section — borderline findings with expert reasoning (these were NOT auto-fixed but deserve human review)',
        '4. Fix confidence convergence history (attempts per batch, score progression)',
        '5. Dismissed findings (false positives correctly filtered)',
        '6. Any remaining verified issues',
        '7. Recommendations (flag any fixes with confidence < 70 as needing manual review)',
        '',
        'Save the report to: ' + args.projectDir + '/BUG-HUNT-REPORT.md',
        '',
        'Return ONLY JSON: {"reportPath": "...", "summary": "one-line summary"}',
      ],
      outputFormat: 'JSON',
    },
  },
}));
