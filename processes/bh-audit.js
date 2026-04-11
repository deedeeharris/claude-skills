/**
 * @process generic/bh-audit
 * @description Audit-only bug hunter: scan any repo with parallel agents, verify with 3 independent expert judges (weighted scoring + expert veto), deduplicate, prove root cause, and generate report. NEVER fixes bugs — report only.
 * @inputs { projectDir: string, testCmd?: string, categories?: string[], scanTarget?: string, severityFilter?: string, maxFindings?: number }
 * @outputs { success: boolean, totalFound: number, dismissed: number, needsAttention: number, verified: number, hebrewSummary: string }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

const ALL_CATEGORIES = ['logic', 'security', 'memory-lifecycle', 'error-handling', 'performance', 'thread-safety'];
const DEFAULT_MAX_FINDINGS = 30;

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

export async function process(inputs, ctx) {
  const {
    projectDir,
    testCmd: testCmdOverride,
    categories = ALL_CATEGORIES,
    scanTarget = 'both',
    severityFilter = 'low',
    maxFindings = DEFAULT_MAX_FINDINGS,
  } = inputs;

  if (!projectDir) throw new Error('projectDir is required');

  const projectInfo = await ctx.task(detectProjectTask, { projectDir, testCmdOverride });
  const { testCmd, srcDirs } = projectInfo;

  let worktreePath = null;
  let allVerified = [];
  let allNeedsAttention = [];
  let allDismissed = [];
  let totalFound = 0;

  const targets = [];
  if (scanTarget === 'both' || scanTarget === 'current') targets.push('current');
  if (scanTarget === 'both' || scanTarget === 'dev') targets.push('dev');

  for (const target of targets) {
    let scanDir = projectDir;

    if (target === 'dev') {
      const worktreeResult = await ctx.task(setupDevWorktreeTask, { projectDir });
      worktreePath = worktreeResult.worktreePath;
      scanDir = worktreePath;
    }

    if (testCmd) {
      await ctx.task(runTestsTask, { projectDir: scanDir, testCmd });
    }

    const scanResults = await ctx.parallel.map(categories, (category) =>
      ctx.task(scanBugsTask, { projectDir: scanDir, srcDirs, category, target })
    );

    const rawFindings = scanResults.flat();
    if (rawFindings.length === 0) continue;

    const dedupResult = await ctx.task(deduplicateFindingsTask, { findings: rawFindings });
    const allFindings = dedupResult.unique || rawFindings;
    totalFound += allFindings.length;

    const [softwareEngineerScores, dataEngineerScores, securitySpecialistScores] = await ctx.parallel.all([
      () => ctx.task(softwareEngineerJudgeTask, { projectDir: scanDir, findings: allFindings }),
      () => ctx.task(dataEngineerJudgeTask, { projectDir: scanDir, findings: allFindings }),
      () => ctx.task(securitySpecialistJudgeTask, { projectDir: scanDir, findings: allFindings }),
    ]);

    const verificationResult = await ctx.task(mergeJudgeScoresTask, {
      findings: allFindings,
      softwareEngineerScores: softwareEngineerScores.scores || [],
      dataEngineerScores: dataEngineerScores.scores || [],
      securitySpecialistScores: securitySpecialistScores.scores || [],
    });

    const tagWithSource = (items) => items.map(item => ({ ...item, scanSource: target }));
    allVerified.push(...tagWithSource(verificationResult.verified || []));
    allNeedsAttention.push(...tagWithSource(verificationResult.needsAttention || []));
    allDismissed.push(...tagWithSource(verificationResult.dismissed || []));

    if (target === 'dev' && worktreePath) {
      await ctx.task(cleanupWorktreeTask, { projectDir, worktreePath });
    }
  }

  if (allVerified.length === 0 && allNeedsAttention.length === 0) {
    return {
      success: true,
      totalFound,
      dismissed: allDismissed.length,
      needsAttention: 0,
      verified: 0,
      hebrewSummary: 'לא נמצאו באגים.',
    };
  }

  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  allVerified.sort((a, b) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99));

  const proveResult = await ctx.task(proveAllBugsTask, { projectDir, bugs: allVerified, testCmd });
  const provenBugs = proveResult.proven || [];
  const unproven = proveResult.unproven || [];
  allNeedsAttention.push(...unproven.map(b => ({ ...b, expertReasoning: 'verified but could not prove concrete reproduction' })));

  const report = await ctx.task(auditReportTask, {
    projectDir,
    totalFound,
    verified: provenBugs,
    needsAttention: allNeedsAttention,
    dismissed: allDismissed.length,
    scanTarget,
    severityFilter,
  });

  return {
    success: true,
    totalFound,
    dismissed: allDismissed.length,
    needsAttention: allNeedsAttention.length,
    verified: provenBugs.length,
    hebrewSummary: report.hebrewSummary,
    reportPath: report.reportPath,
    bugCount: provenBugs.length + allNeedsAttention.length,
  };
}

export const detectProjectTask = defineTask('detect-project', (args) => ({
  kind: 'agent',
  title: 'Detect project language, test command, and source directories',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'DevOps engineer analyzing a repository',
      task: `Detect the project type, language, framework, test command, and source directories for the repo at ${args.projectDir}.`,
      instructions: [
        `Read the repo root at ${args.projectDir}. Look for:`,
        '- package.json, pyproject.toml, go.mod, Cargo.toml, Makefile, etc.',
        '- Identify test command (pytest, jest, vitest, go test, etc.)',
        '- Identify main source directories (src/, app/, lib/, etc.)',
        '',
        args.testCmdOverride ? `User override for testCmd: ${args.testCmdOverride}` : 'No testCmd override — auto-detect. If no test framework found, set testCmd to null.',
        '',
        'Return ONLY JSON:',
        '{"language": "...", "framework": "...", "testCmd": "..." or null, "srcDirs": ["..."], "testDirs": ["..."]}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

export const setupDevWorktreeTask = defineTask('setup-dev-worktree', (args) => ({
  kind: 'agent',
  title: 'Create git worktree for dev branch scanning',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Git operations specialist',
      task: `Create a temporary git worktree to scan the dev branch independently.`,
      instructions: [
        `Project: ${args.projectDir}`,
        '',
        'Run these commands:',
        '1. git fetch origin dev',
        '2. git worktree add /tmp/bh-dev-scan origin/dev',
        '',
        'If the worktree already exists, remove it first:',
        '  git worktree remove /tmp/bh-dev-scan --force',
        '  Then retry the add.',
        '',
        'Return ONLY JSON:',
        '{"worktreePath": "/tmp/bh-dev-scan", "success": true}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

export const cleanupWorktreeTask = defineTask('cleanup-worktree', (args) => ({
  kind: 'agent',
  title: 'Remove temporary dev worktree',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Git operations specialist',
      task: `Remove the temporary git worktree at ${args.worktreePath}.`,
      instructions: [
        `Run: cd ${args.projectDir} && git worktree remove ${args.worktreePath} --force`,
        '',
        'Return ONLY JSON: {"success": true}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

export const runTestsTask = defineTask('run-tests', (args) => ({
  kind: 'agent',
  title: 'Run test suite as pre-scan check',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer running tests',
      task: `Run the test suite to identify any existing failures before scanning.`,
      instructions: [
        `cd ${args.projectDir} && ${args.testCmd}`,
        '',
        'Report test results. Any failures are findings themselves.',
        '',
        'IMPORTANT: Do NOT fix anything. Report only.',
        '',
        'Return ONLY JSON:',
        '{"testsRun": N, "passed": N, "failed": N, "failures": [{"test": "...", "error": "..."}]}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

export const scanBugsTask = defineTask('scan-bugs', (args) => ({
  kind: 'agent',
  title: `Scan for ${args.category} bugs [${args.target}]`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: `Senior ${args.category} specialist performing a focused code audit`,
      task: `Scan the codebase for ${args.category} bugs. This is a ${args.target}-branch scan.`,
      instructions: [
        `Project: ${args.projectDir}`,
        `Source directories: ${JSON.stringify(args.srcDirs)}`,
        `Category: ${args.category}`,
        `Scan target: ${args.target} branch`,
        '',
        'Read source files in the project and look for bugs in your category.',
        '',
        'Category-specific guidance:',
        args.category === 'logic' ? 'Look for: incorrect conditionals, off-by-one, wrong operators, missing null checks, unreachable code, wrong return values.' : '',
        args.category === 'security' ? 'Look for: injection, auth bypass, data exposure, hardcoded secrets, unsafe operations, OWASP top 10.' : '',
        args.category === 'memory-lifecycle' ? 'Look for: resource leaks, unclosed connections, missing cleanup, dangling references.' : '',
        args.category === 'error-handling' ? 'Look for: swallowed exceptions, missing error handling, generic catch blocks, unvalidated input at boundaries.' : '',
        args.category === 'performance' ? 'Look for: N+1 queries, unnecessary allocations, missing indexes, unbounded loops, redundant computation.' : '',
        args.category === 'thread-safety' ? 'Look for: race conditions, missing locks, shared mutable state, non-atomic operations.' : '',
        args.category === 'sql-logic' ? 'Look for: missing DISTINCT, fan-out JOINs, NULL handling in CASE/WHERE, wrong aggregation, incorrect GROUP BY.' : '',
        args.category === 'data-integrity' ? 'Look for: type mismatches between layers, missing WHERE filters, stale CDC data assumptions, schema drift.' : '',
        args.category === 'resource-config' ? 'Look for: hardcoded values, env var leaks, wrong dataset/project references, connection pool issues.' : '',
        args.category === 'pipeline-logic' ? 'Look for: wrong asset dependencies, schedule race conditions, missing upstream checks, materialization order.' : '',
        args.category === 'test-gaps' ? 'Look for: inline SQL drift from production SQL, uncovered edge cases, missing assertions, test isolation issues.' : '',
        args.category === 'conventions' ? 'Look for: abbreviated names, comments in code, files > 200 lines, wrong naming conventions.' : '',
        args.category === 'contract-drift' ? 'Look for: schema contract mismatches between packages, missing fields, type differences.' : '',
        '',
        'IMPORTANT: Report ONLY actual bugs, not style preferences.',
        'Do NOT fix anything. Report only.',
        '',
        'Return ONLY JSON array:',
        '[{"id": "' + args.category + '-N", "file": "path/to/file", "line": N, "category": "' + args.category + '", "severity": "critical|high|medium|low", "title": "short title", "description": "detailed description"}]',
      ],
      outputFormat: 'JSON',
    },
  },
}));

export const deduplicateFindingsTask = defineTask('deduplicate-findings', (args) => ({
  kind: 'agent',
  title: `Deduplicate ${args.findings.length} findings`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA analyst deduplicating bug reports',
      task: `Deduplicate ${args.findings.length} findings by file+line+root-cause similarity.`,
      instructions: [
        'Merge findings that report the same underlying issue.',
        'When merging: keep highest severity, combine categories, use best description.',
        '',
        'FINDINGS:',
        JSON.stringify(args.findings, null, 2),
        '',
        'Return ONLY JSON:',
        '{"unique": [<deduplicated array>], "duplicatesRemoved": N, "mergeLog": ["merged X into Y"]}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

function createJudgeInstructions(judgeName, focusAreas, expertCategories, args) {
  return [
    `You are a ${judgeName}. You are ONE of 3 independent judges evaluating bug findings.`,
    'You do NOT see the other judges\' scores. Score each finding independently.',
    '',
    `YOUR FOCUS AREAS: ${focusAreas}`,
    `YOUR EXPERT CATEGORIES: ${expertCategories.join(', ')}`,
    '',
    'FOR EACH FINDING:',
    '1. Read the actual source file at the reported location',
    '2. Evaluate whether this is a real bug from YOUR specialist perspective',
    '3. Score your CONFIDENCE (0-100) that this is a real bug',
    '   0 = definitely not a bug, 100 = absolutely certain it is a bug',
    '4. Provide a brief reasoning for your score',
    '',
    `Project root: ${args.projectDir}`,
    '',
    'BE SKEPTICAL. Require evidence from reading the actual code.',
    '',
    'FINDINGS TO EVALUATE:',
    JSON.stringify(args.findings, null, 2),
    '',
    'Do ONLY scoring. Do NOT fix bugs.',
    '',
    'Return ONLY JSON:',
    '{"scores": [{"findingId": "...", "confidence": N, "reasoning": "..."}]}',
  ];
}

export const softwareEngineerJudgeTask = defineTask('judge-software-engineer', (args) => ({
  kind: 'agent',
  title: `Judge 1/3: Software Engineer evaluates ${args.findings.length} findings`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior Software Engineer specializing in code correctness and test quality',
      task: `Independently score ${args.findings.length} bug findings. You are 1 of 3 judges — you do NOT see others' scores.`,
      instructions: createJudgeInstructions(
        'Senior Software Engineer',
        'code correctness, logic errors, edge cases, null safety, error handling, test coverage gaps, convention violations, contract drift',
        ['logic', 'error-handling', 'test-gaps', 'conventions', 'contract-drift'],
        args,
      ),
      outputFormat: 'JSON',
    },
  },
}));

export const dataEngineerJudgeTask = defineTask('judge-data-engineer', (args) => ({
  kind: 'agent',
  title: `Judge 2/3: Data/Infrastructure Engineer evaluates ${args.findings.length} findings`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior Data Engineer specializing in SQL, data pipelines, and data integrity',
      task: `Independently score ${args.findings.length} bug findings. You are 1 of 3 judges — you do NOT see others' scores.`,
      instructions: createJudgeInstructions(
        'Senior Data/Infrastructure Engineer',
        'data integrity, SQL correctness (JOINs, NULLs, aggregations, fan-out), pipeline dependencies, CDC data flow, resource configuration',
        ['sql-logic', 'data-integrity', 'resource-config', 'pipeline-logic'],
        args,
      ),
      outputFormat: 'JSON',
    },
  },
}));

export const securitySpecialistJudgeTask = defineTask('judge-security-specialist', (args) => ({
  kind: 'agent',
  title: `Judge 3/3: Security & Systems Specialist evaluates ${args.findings.length} findings`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior Security and Systems Engineer specializing in vulnerabilities and concurrency',
      task: `Independently score ${args.findings.length} bug findings. You are 1 of 3 judges — you do NOT see others' scores.`,
      instructions: createJudgeInstructions(
        'Security & Systems Specialist',
        'security vulnerabilities, injection, auth bypass, memory leaks, resource cleanup, concurrency, race conditions, performance',
        ['security', 'memory-lifecycle', 'performance', 'thread-safety'],
        args,
      ),
      outputFormat: 'JSON',
    },
  },
}));

export const mergeJudgeScoresTask = defineTask('merge-judge-scores', (args) => ({
  kind: 'agent',
  title: `Merge 3 independent judge scores for ${args.findings.length} findings`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Impartial scoring coordinator merging independent judge evaluations',
      task: `Merge scores from 3 independent judges for ${args.findings.length} findings using weighted scoring and expert veto.`,
      instructions: [
        'JUDGES AND EXPERT CATEGORIES:',
        '  Software Engineer: logic, error-handling, test-gaps, conventions, contract-drift',
        '  Data Engineer: sql-logic, data-integrity, resource-config, pipeline-logic',
        '  Security Specialist: security, memory-lifecycle, performance, thread-safety',
        '',
        'SCORING: Expert gets ×2 weight. weightedAverage = sum(score × weight) / sum(weights)',
        '',
        'CLASSIFICATION:',
        `  Expert Veto: domain expert ≥${EXPERT_VETO_THRESHOLD} → VERIFIED`,
        `  Weighted average ≥${VERIFIED_THRESHOLD} → VERIFIED`,
        `  Weighted average ${NEEDS_ATTENTION_THRESHOLD}-${VERIFIED_THRESHOLD - 1} → NEEDS ATTENTION`,
        `  Weighted average <${NEEDS_ATTENTION_THRESHOLD} → DISMISSED`,
        '',
        'CATEGORY-TO-EXPERT MAPPING:',
        JSON.stringify(CATEGORY_TO_EXPERT, null, 2),
        '',
        'Software Engineer scores:', JSON.stringify(args.softwareEngineerScores, null, 2),
        'Data Engineer scores:', JSON.stringify(args.dataEngineerScores, null, 2),
        'Security Specialist scores:', JSON.stringify(args.securitySpecialistScores, null, 2),
        '',
        'FINDINGS:', JSON.stringify(args.findings.map(f => ({ id: f.id, category: f.category, file: f.file, title: f.title })), null, 2),
        '',
        'Return ONLY JSON:',
        '{"verified": [...], "needsAttention": [...], "dismissed": [...]}',
        'Each item includes: original finding fields + judgeScores, expertJudge, weightedAverage, expertVeto, evidence/expertReasoning/reason',
      ],
      outputFormat: 'JSON',
    },
  },
}));

export const proveAllBugsTask = defineTask('prove-all-bugs', (args) => ({
  kind: 'agent',
  title: `Prove root cause for ${args.bugs.length} verified bugs`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'QA engineer proving bug root causes',
      task: `For each of ${args.bugs.length} verified bugs, prove the root cause with a concrete reproduction scenario.`,
      instructions: [
        `Project: ${args.projectDir}`,
        args.testCmd ? `Test command: ${args.testCmd}` : 'No test framework detected.',
        '',
        'For each bug:',
        '1. Trace the concrete code path that triggers the bug',
        '2. Describe the exact input/state that causes the problem',
        '3. Describe expected vs actual behavior',
        '4. Assess production impact',
        '',
        'CRITICAL: Do NOT suggest fixes. Do NOT write code. Report the root cause ONLY.',
        '',
        'BUGS TO PROVE:',
        JSON.stringify(args.bugs, null, 2),
        '',
        'Return ONLY JSON:',
        '{"proven": [<bugs with added "rootCause", "reproductionScenario", "impact", "affectedPaths" fields>], "unproven": [<bugs that could not be concretely proven>]}',
      ],
      outputFormat: 'JSON',
    },
  },
}));

export const auditReportTask = defineTask('audit-report', (args) => ({
  kind: 'agent',
  title: 'Generate audit report with Hebrew summary',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Technical writer creating a bug audit report',
      task: 'Generate a final audit report. This is an AUDIT — no fixes were applied.',
      instructions: [
        `Project: ${args.projectDir}`,
        `Scan target: ${args.scanTarget}`,
        `Total findings: ${args.totalFound}`,
        `Verified bugs: ${args.verified.length}`,
        `Needs attention: ${args.needsAttention.length}`,
        `Dismissed: ${args.dismissed}`,
        '',
        'VERIFIED BUGS:',
        JSON.stringify(args.verified.map(b => ({
          id: b.id, title: b.title, file: b.file, line: b.line, severity: b.severity,
          category: b.category, rootCause: b.rootCause, impact: b.impact,
          weightedAverage: b.weightedAverage, expertVeto: b.expertVeto, scanSource: b.scanSource,
        })), null, 2),
        '',
        'NEEDS ATTENTION:',
        JSON.stringify(args.needsAttention.map(b => ({
          id: b.id, title: b.title, file: b.file, category: b.category,
          weightedAverage: b.weightedAverage, expertReasoning: b.expertReasoning, scanSource: b.scanSource,
        })), null, 2),
        '',
        'Write a markdown report with:',
        '1. Summary table (verified count, needs-attention count, dismissed count, per scan target)',
        '2. Verified bugs grouped by severity — file, line, root cause, impact, judge scores',
        '3. Needs Attention section — expert reasoning for each',
        '4. Dismissed count (no details)',
        '',
        'IMPORTANT: This is an audit report. Do NOT suggest fixes or code changes.',
        'Tag each finding with [current] or [dev] based on scanSource.',
        '',
        `Save the report to: ${args.projectDir}/BH-AUDIT-REPORT.md`,
        '',
        'Also generate a HEBREW SUMMARY (3-5 lines) for Telegram notification.',
        'The Hebrew summary should list: count of verified + needs-attention, top 3 by severity, scan target.',
        '',
        'Return ONLY JSON: {"reportPath": "...", "hebrewSummary": "...", "summary": "one-line English summary"}',
      ],
      outputFormat: 'JSON',
    },
  },
}));
