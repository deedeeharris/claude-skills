/**
 * @process deep-plan-verification
 * @description Autonomous iterative plan verification loop: scan codebase -> identify questions (6 parallel dimensions) -> dedup -> prove gaps -> self-answer -> 3-judge review -> update plan -> consistency gate -> score quality -> repeat until 95/100. Composable module for babysitter workflows. PROJECT-AGNOSTIC.
 * @inputs { planFile: string, projectRoot: string, qualityThreshold: number, maxIterations: number, requireApproval: boolean, taskDescription: string }
 * @outputs { success: boolean, verified: boolean, iterations: number, finalScore: number, planFile: string, verificationHistory: array }
 */

import { defineTask } from '@a5c-ai/babysitter-sdk';

/**
 * Deep Plan Verification Process (Global Template)
 *
 * Autonomous iterative plan verification that runs as Phase 0 of every babysitter workflow.
 *
 * PHASE 1: PARALLEL CODEBASE SCAN (3 agents)
 *   - Backend/server analysis: scan server-side files, check implementations, find patterns
 *   - Frontend/client analysis: scan client-side files, check components, find reusables
 *   - Integration analysis: scan APIs, DB models, config, external deps, deployment
 *
 * PHASE 2: ITERATIVE VERIFICATION LOOP (up to maxIterations rounds, convergent)
 *   For each iteration:
 *     a. PARALLEL QUESTION IDENTIFICATION — 6 specialized dimension agents run simultaneously:
 *        implementation gaps, security/auth, edge cases & error handling,
 *        testing strategy, deployment/migration, architectural conflicts
 *     b. MERGE + DEDUP — combine all dimension findings, drop duplicates of prior-iteration questions
 *     c. PROVE THE GAPS — filter phantom gaps: a grounded agent traces actual code to confirm
 *        each question would cause a real problem if the plan were implemented as-is
 *     d. SELF-ANSWER — senior dev agent answers ALL proven questions with deep codebase knowledge
 *        (no shortcuts, no lazy answers, grounded in actual code)
 *     e. 3-JUDGE REVIEW — three independent reviewers check each answer is specific, code-grounded,
 *        and actually resolves the question; rejected answers go back for revision
 *     f. PLAN UPDATE — incorporate approved decisions into the plan file
 *     g. CONSISTENCY GATE — check if this iteration's additions introduced any new contradictions
 *        with existing plan sections
 *     h. QUALITY SCORING — score plan on 8 dimensions (0-100)
 *     i. CONVERGENCE CHECK — verified when score >= threshold AND no new critical questions
 *
 * PHASE 3: FINAL APPROVAL (optional breakpoint)
 *   - If requireApproval=true, pause for user review before continuing
 *   - Otherwise auto-continue to execution
 */

// ============================================================================
// QUESTION DIMENSIONS — 6 specialized lenses for parallel gap identification
// ============================================================================

const QUESTION_DIMENSIONS = {
  'implementation': {
    title: 'Implementation Gaps',
    role: 'Senior backend/frontend engineer reviewing implementation completeness with a focus on whether every requirement has a concrete, unambiguous execution path.',
    focus: 'Missing implementation steps, unclear execution order, unspecified data structures or schemas, missing function signatures or interfaces, unclear business logic branching, missing state transitions, unspecified API request/response contracts, missing pagination/sorting/filtering logic, ambiguous ownership of side effects.'
  },
  'security': {
    title: 'Security & Auth Concerns',
    role: 'Senior application security engineer reviewing for vulnerabilities and auth gaps. You are paranoid by default and assume hostile inputs.',
    focus: 'Missing authentication checks, missing authorization/permission checks, unvalidated or unsanitized inputs, injection risks (SQL, command, XSS), secrets or tokens exposed in logs or responses, insecure defaults, missing rate limiting, missing CSRF protection, path traversal risks, insecure direct object references, data exposed to wrong callers.'
  },
  'edge-cases': {
    title: 'Edge Cases & Error Handling',
    role: 'QA engineer who specializes in breaking systems. You think in extremes: empty, null, zero, maximum, concurrent, slow, disconnected.',
    focus: 'Missing null/undefined/empty handling, missing boundary checks, concurrent access and race conditions, partial failure scenarios (what if step 3 of 5 fails?), timeout handling, retry logic and idempotency, cleanup on failure paths (rollback, resource release), missing error propagation to callers, swallowed exceptions, unexpected state combinations that the plan does not address.'
  },
  'testing': {
    title: 'Testing Strategy Gaps',
    role: 'Senior test architect who has seen many codebases ship with false confidence from bad tests. You demand specificity.',
    focus: 'Missing unit test specs (which exact behaviors need tests?), missing integration test scenarios, untestable code paths (no seams for mocking), missing E2E scenarios, missing negative test cases (what SHOULD fail?), missing test data setup and teardown, missing performance or load test cases where relevant, missing contract tests for external integrations, tests that would pass even if the feature is broken.'
  },
  'deployment': {
    title: 'Deployment & Migration Concerns',
    role: 'Platform/DevOps engineer who has been paged at 3am because of a botched migration. You think in terms of zero-downtime, rollback, and safe defaults.',
    focus: 'Missing data migration steps, backward compatibility gaps (old clients calling new endpoints), missing rollback procedure, environment-specific configuration not addressed, feature flag strategy, migration ordering dependencies (which runs first?), missing pre/post-deployment verification steps, implications for running instances during deploy, missing index creation or schema changes.'
  },
  'architecture': {
    title: 'Architectural Conflicts',
    role: 'Staff engineer who has deep knowledge of this codebase and its established conventions. You enforce consistency ruthlessly.',
    focus: 'Contradictions with existing codebase patterns or established conventions, naming collisions with existing functions/tables/events/routes, tight coupling introduced by this plan, circular dependencies, violations of existing abstractions or boundaries, breaking changes to shared interfaces or contracts, inconsistent error-handling patterns, mixed abstraction levels, deviations from existing folder structure or module organization.'
  }
};

// ============================================================================
// MAIN PROCESS
// ============================================================================

export async function process(inputs, ctx) {
  const {
    planFile,
    projectRoot = '.',
    qualityThreshold = 95,
    maxIterations = 10,
    requireApproval = false,
    taskDescription = ''
  } = inputs;

  // ============================================================================
  // PHASE 1: PARALLEL CODEBASE SCAN (3 agents)
  // ============================================================================

  const [backendAnalysis, frontendAnalysis, integrationAnalysis] = await ctx.parallel.all([
    () => ctx.task(scanBackendTask, { planFile, projectRoot, taskDescription }),
    () => ctx.task(scanFrontendTask, { planFile, projectRoot, taskDescription }),
    () => ctx.task(scanIntegrationTask, { planFile, projectRoot, taskDescription })
  ]);

  const codebaseScan = {
    backend: backendAnalysis,
    frontend: frontendAnalysis,
    integration: integrationAnalysis
  };

  // ============================================================================
  // PHASE 2: ITERATIVE VERIFICATION LOOP
  // ============================================================================

  let iteration = 0;
  let verified = false;
  let currentScore = 0;
  let previousScore = 0;
  const verificationHistory = [];

  while (!verified && iteration < maxIterations) {
    iteration++;

    // Step A: Identify questions IN PARALLEL across 6 specialized dimensions
    const dimensionResults = await ctx.parallel.map(
      Object.keys(QUESTION_DIMENSIONS),
      (dimension) => ctx.task(identifyDimensionQuestionsTask, {
        planFile, projectRoot, taskDescription, codebaseScan,
        dimension, iteration, previousHistory: verificationHistory
      })
    );

    // Step A.5: Merge all dimension findings + dedup against prior iterations
    const mergedQuestions = await ctx.task(mergeAndDedupQuestionsTask, {
      planFile, projectRoot, dimensionResults, iteration,
      resolvedHistory: verificationHistory.map(h => ({
        iteration: h.iteration,
        questionsAnswered: h.questionsAnswered || []
      }))
    });

    // Step A.7: Prove the gaps — filter phantom gaps before wasting self-answer tokens
    const provenQuestions = await ctx.task(proveGapsTask, {
      planFile, projectRoot, taskDescription, codebaseScan,
      questions: mergedQuestions, iteration
    });

    // Step B: Self-answer ALL proven questions as a senior developer
    const answers = await ctx.task(selfAnswerQuestionsTask, {
      planFile, projectRoot, taskDescription, codebaseScan,
      questions: provenQuestions, iteration, previousHistory: verificationHistory
    });

    // Step B.5: 3-judge review — validate answer quality before writing to plan
    const reviewedAnswers = await ctx.task(judgeAnswersTask, {
      planFile, projectRoot, questions: provenQuestions,
      answers, iteration
    });

    // Step C: Update the plan file with approved decisions only
    const planUpdate = await ctx.task(updatePlanTask, {
      planFile, projectRoot, questions: provenQuestions,
      answers: reviewedAnswers, iteration, previousHistory: verificationHistory
    });

    // Step C.5: Consistency gate — catch contradictions introduced by this iteration's additions
    const consistency = await ctx.task(consistencyGateTask, {
      planFile, projectRoot, planUpdate, iteration
    });

    // Step D: Score plan quality on 8 dimensions
    const scoring = await ctx.task(scorePlanQualityTask, {
      planFile, projectRoot, taskDescription, codebaseScan,
      iteration, qualityThreshold, previousHistory: verificationHistory
    });

    previousScore = currentScore;
    currentScore = scoring.overallScore;

    verificationHistory.push({
      iteration,
      // Dimension breakdown for diagnostics
      dimensionCounts: dimensionResults.map((r, i) => ({
        dimension: Object.keys(QUESTION_DIMENSIONS)[i],
        found: r.totalQuestions || 0
      })),
      questionsFound: mergedQuestions.totalQuestions || 0,
      phantomsFiltered: mergedQuestions.totalQuestions - (provenQuestions.totalProven || 0),
      criticalQuestions: provenQuestions.criticalCount || 0,
      answersProvided: answers.totalAnswered || 0,
      answersRejectedByJudges: reviewedAnswers.rejectedCount || 0,
      planChanges: planUpdate.changesApplied || 0,
      consistencyIssuesFound: consistency.issuesFound || 0,
      score: currentScore,
      dimensionScores: scoring.dimensionScores,
      scoreImprovement: currentScore - previousScore,
      remainingGaps: scoring.remainingGaps,
      // Store resolved question summaries so next iteration can dedup against them
      questionsAnswered: (provenQuestions.questions || []).map(q => ({
        id: q.id,
        title: q.title,
        summary: (q.description || '').substring(0, 150)
      })),
      timestamp: ctx.now()
    });

    // Step E: Convergence check
    const noCriticalQuestions = (provenQuestions.criticalCount || 0) === 0;
    const scoreAboveThreshold = currentScore >= qualityThreshold;
    const minimalNewQuestions = (mergedQuestions.newQuestionsCount || 0) <= 1;

    verified = scoreAboveThreshold && noCriticalQuestions && minimalNewQuestions;

    // Safety: detect stagnation (score not moving despite iterations)
    if (!verified && iteration >= 3) {
      const last3 = verificationHistory.slice(-3);
      const stagnating = last3.every(h => h.scoreImprovement < 2);
      if (stagnating && currentScore >= qualityThreshold - 5) {
        verified = true;
      }
    }
  }

  // ============================================================================
  // PHASE 3: FINAL APPROVAL (conditional breakpoint)
  // ============================================================================

  if (requireApproval) {
    await ctx.breakpoint({
      question: `Plan verification ${verified ? 'CONVERGED' : 'completed (max iterations)'} after ${iteration} rounds. Score: ${currentScore}/${qualityThreshold}. Review the verified plan before execution?`,
      title: `Plan Verification Complete: ${currentScore}/${qualityThreshold}`,
      context: {
        runId: ctx.runId,
        files: [{ path: planFile, format: 'markdown', label: 'Verified Plan' }]
      }
    });
  }

  return {
    success: verified,
    verified,
    iterations: iteration,
    maxIterations,
    qualityThreshold,
    finalScore: currentScore,
    planFile,
    taskDescription,
    scoreProgression: verificationHistory.map(h => h.score),
    phantomsFilteredTotal: verificationHistory.reduce((sum, h) => sum + (h.phantomsFiltered || 0), 0),
    judgeRejectionsTotal: verificationHistory.reduce((sum, h) => sum + (h.answersRejectedByJudges || 0), 0),
    verificationHistory,
    codebaseScan: {
      backendFiles: backendAnalysis.filesAnalyzed || [],
      frontendFiles: frontendAnalysis.filesAnalyzed || [],
      integrationPoints: integrationAnalysis.integrationPoints || []
    },
    metadata: { processId: 'deep-plan-verification', timestamp: ctx.now() }
  };
}

// ============================================================================
// TASK DEFINITIONS — PHASE 1: CODEBASE SCAN (unchanged)
// ============================================================================

export const scanBackendTask = defineTask('scan-backend', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Scan backend/server codebase',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior backend engineer with deep knowledge of this specific codebase. You read actual code, not assumptions.',
      task: 'Analyze server-side files mentioned in or relevant to the plan. Find existing implementations, patterns, potential conflicts, and reusable code.',
      context: {
        planFile: args.planFile,
        projectRoot: args.projectRoot,
        taskDescription: args.taskDescription
      },
      instructions: [
        `Read the plan file: "${args.projectRoot}/${args.planFile}"`,
        '',
        'Then systematically scan the server-side codebase:',
        '',
        '1. DISCOVER PROJECT STRUCTURE: First, read CLAUDE.md, README.md, or any project documentation to understand the tech stack, architecture, and conventions.',
        '',
        '2. MENTIONED FILES: Read every backend/server file explicitly mentioned in the plan. Note their current state.',
        '',
        '3. AFFECTED FILES: Identify files NOT mentioned but that will be affected (imports, dependencies, callers).',
        '',
        '4. EXISTING PATTERNS: Find similar implementations that the plan should follow.',
        '   - How are similar features structured?',
        '   - What error handling patterns are used?',
        '   - What testing patterns exist?',
        '',
        '5. POTENTIAL CONFLICTS: Check for:',
        '   - Naming collisions (functions, routes, collection/table names)',
        '   - Import cycles',
        '   - Session/state contamination risks',
        '   - Database access patterns',
        '',
        '6. REUSABLE CODE: Find existing utilities, services, or patterns the plan could leverage.',
        '',
        '7. KEY GOTCHAS: Note any project-specific gotchas from CLAUDE.md or documentation.',
        '',
        'Be thorough. Read actual file contents, not just file names.',
        'Return specific file paths, line numbers, and code snippets where relevant.'
      ],
      outputFormat: 'JSON with filesAnalyzed (array of {path, summary, relevance}), existingPatterns (array of {pattern, file, description}), conflicts (array of {description, severity, files}), reusableCode (array of {description, file, howToUse}), gotchas (array of string), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['filesAnalyzed', 'existingPatterns', 'conflicts', 'summary']
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  },
  labels: ['scan', 'backend']
}));

export const scanFrontendTask = defineTask('scan-frontend', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Scan frontend/client codebase',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior frontend engineer with deep knowledge of this specific codebase. You read actual code, not assumptions.',
      task: 'Analyze client-side files mentioned in or relevant to the plan. Find existing components, patterns, and reusable elements.',
      context: {
        planFile: args.planFile,
        projectRoot: args.projectRoot,
        taskDescription: args.taskDescription
      },
      instructions: [
        `Read the plan file: "${args.projectRoot}/${args.planFile}"`,
        '',
        'Then systematically scan the client-side codebase:',
        '',
        '1. DISCOVER PROJECT STRUCTURE: Read CLAUDE.md, README.md, package.json to understand the frontend tech stack (React, Vue, Svelte, etc.), conventions, and architecture.',
        '',
        '2. MENTIONED FILES: Read every frontend file explicitly mentioned in the plan.',
        '',
        '3. AFFECTED COMPONENTS: Identify components, routes, state management, and services that will be affected.',
        '',
        '4. EXISTING PATTERNS: Find UI patterns, component structures, and styling approaches to follow.',
        '',
        '5. REUSABLE COMPONENTS: Find existing components that could be reused or composed.',
        '',
        '6. API/SOCKET EVENTS: Check client services for any API/WebSocket event handling relevant to the plan.',
        '',
        '7. BUILD IMPLICATIONS: Note if changes affect the build output or deployment.',
        '',
        'If the plan is purely backend, still check for frontend integration points.',
        'Return specific file paths and component names.'
      ],
      outputFormat: 'JSON with filesAnalyzed (array of {path, summary, relevance}), existingPatterns (array of {pattern, file}), reusableComponents (array of {name, path, howToUse}), apiEndpoints (array of {endpoint, handler}), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['filesAnalyzed', 'summary']
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  },
  labels: ['scan', 'frontend']
}));

export const scanIntegrationTask = defineTask('scan-integration', (args, taskCtx) => ({
  kind: 'agent',
  title: 'Scan integration points',
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior integration engineer with deep knowledge of this specific codebase and its deployment model.',
      task: 'Analyze API endpoints, database models, authentication flows, external services, and deployment concerns relevant to the plan.',
      context: {
        planFile: args.planFile,
        projectRoot: args.projectRoot,
        taskDescription: args.taskDescription
      },
      instructions: [
        `Read the plan file: "${args.projectRoot}/${args.planFile}"`,
        '',
        'Then analyze integration concerns:',
        '',
        '1. DISCOVER PROJECT STRUCTURE: Read CLAUDE.md, README.md, docker-compose.yml, Dockerfile, CI/CD config to understand the deployment model and infrastructure.',
        '',
        '2. API ENDPOINTS: Check existing routes that the plan touches or needs.',
        '   - Review router/controller files for relevant endpoints',
        '   - Check authentication/authorization middleware',
        '',
        '3. DATABASE: Check database models, schemas, migrations, and queries relevant to the plan.',
        '   - What ORM/driver is used?',
        '   - What are the access patterns?',
        '',
        '4. EXTERNAL SERVICES: Check for integration with external APIs, services, providers.',
        '',
        '5. CONFIGURATION: Check environment variables, config files, secrets management.',
        '',
        '6. DEPLOYMENT: Identify deployment implications.',
        '   - CI/CD pipeline',
        '   - Container/serverless config',
        '   - Migration strategy',
        '',
        'Return specific integration points with file references.'
      ],
      outputFormat: 'JSON with integrationPoints (array of {type, description, files, concerns}), dbModels (array of {name, relevance}), externalServices (array of {name, relevance}), deploymentConcerns (array of string), envVars (array of {name, purpose}), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['integrationPoints', 'summary']
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  },
  labels: ['scan', 'integration']
}));

// ============================================================================
// TASK DEFINITIONS — PHASE 2, STEP A: PARALLEL DIMENSION QUESTION IDENTIFICATION
// ============================================================================

/**
 * One of 6 specialized dimension agents. Each runs independently and in parallel.
 * Parameterized by `dimension` — one of the keys in QUESTION_DIMENSIONS.
 */
export const identifyDimensionQuestionsTask = defineTask('identify-dimension-questions', (args, taskCtx) => {
  const dim = QUESTION_DIMENSIONS[args.dimension] || {
    title: args.dimension,
    role: 'Senior engineer reviewing the plan',
    focus: 'All gaps and ambiguities'
  };

  return {
    kind: 'agent',
    title: `Find gaps: ${dim.title} (iteration ${args.iteration})`,
    agent: {
      name: 'general-purpose',
      prompt: {
        role: dim.role,
        task: `Iteration ${args.iteration}: Scan the plan exclusively through the lens of "${dim.title}". Find every gap, ambiguity, and missing decision in this specific domain. Do NOT attempt to cover other domains — other specialized agents are doing that in parallel.`,
        context: {
          planFile: args.planFile,
          projectRoot: args.projectRoot,
          taskDescription: args.taskDescription,
          dimension: args.dimension,
          codebaseScan: args.codebaseScan,
          iteration: args.iteration,
          resolvedInPriorIterations: (args.previousHistory || []).flatMap(h =>
            (h.questionsAnswered || []).filter(q => q.dimension === args.dimension)
          )
        },
        instructions: [
          `Read the CURRENT plan file: "${args.projectRoot}/${args.planFile}"`,
          '',
          `YOUR FOCUS AREA: ${dim.focus}`,
          '',
          'Resolved questions from prior iterations (DO NOT re-raise these):',
          JSON.stringify((args.previousHistory || []).flatMap(h =>
            (h.questionsAnswered || []).map(q => q.title)
          ), null, 2),
          '',
          'For each gap you find:',
          '1. Assign severity: CRITICAL (would cause the implementation to fail or be wrong), HIGH (significant risk of rework), MEDIUM (quality concern), LOW (polish)',
          '2. Reference the specific plan section or line that is missing/ambiguous',
          '3. Reference any relevant code file/pattern from the codebase scan that proves this is a real gap',
          '',
          'RULES:',
          '- Stay in your lane. Only report gaps that fall under: ' + dim.title,
          '- Be specific. "Add error handling" is not a gap. "The plan does not specify what happens when the DB insert fails midway through — does it retry? roll back? return 500?" is a gap.',
          '- Do NOT report gaps already resolved in prior iterations.',
          '- A 95/100 plan must be virtually flawless. Be ruthless within your domain.'
        ],
        outputFormat: `JSON with questions (array of {id: "${args.dimension}-N", dimension: "${args.dimension}", severity: "CRITICAL|HIGH|MEDIUM|LOW", title: string, description: string, planSection: string, codeReference: string}), totalQuestions (number), criticalCount (number), summary (string)`
      },
      outputSchema: {
        type: 'object',
        required: ['questions', 'totalQuestions', 'criticalCount']
      }
    },
    io: {
      inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
      outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
    },
    labels: ['verification', 'questions', args.dimension, `iteration-${args.iteration}`]
  };
});

// ============================================================================
// TASK DEFINITIONS — PHASE 2, STEP A.5: MERGE + DEDUP
// ============================================================================

export const mergeAndDedupQuestionsTask = defineTask('merge-dedup-questions', (args, taskCtx) => ({
  kind: 'agent',
  title: `Merge + dedup questions from 6 dimensions (iteration ${args.iteration})`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Senior engineer merging and deduplicating a multi-source bug/gap report.',
      task: `Merge question lists from 6 parallel dimension agents into a single clean list. Remove duplicates, cross-dimension overlaps, and questions already resolved in prior iterations.`,
      context: {
        dimensionResults: args.dimensionResults,
        iteration: args.iteration,
        resolvedHistory: args.resolvedHistory
      },
      instructions: [
        'You have question lists from 6 dimension agents:',
        JSON.stringify((args.dimensionResults || []).map((r, i) => ({
          dimension: Object.keys(QUESTION_DIMENSIONS)[i],
          count: r.totalQuestions || 0,
          questions: r.questions || []
        })), null, 2),
        '',
        'Previously resolved questions (across ALL prior iterations):',
        JSON.stringify((args.resolvedHistory || []).flatMap(h => h.questionsAnswered || []).map(q => q.title), null, 2),
        '',
        'DEDUPLICATION RULES:',
        '1. Two questions are duplicates if they describe the same underlying gap, even if from different dimensions or phrased differently.',
        '2. When merging duplicates: keep the higher severity, use the more specific description, combine dimension labels.',
        '3. Drop any question that is substantially equivalent to one already resolved in a prior iteration.',
        '4. Questions from different dimensions about the SAME plan gap should be merged into one (with combined dimension labels).',
        '',
        'After deduplication:',
        '- Assign clean sequential IDs: Q1, Q2, Q3...',
        '- Preserve the dimension(s) each question came from',
        '- Count how many were new vs deduplicated vs dropped-as-resolved',
        '',
        'Return ONLY JSON (no markdown).'
      ],
      outputFormat: 'JSON with questions (array of {id, dimensions (array of dimension names), severity, title, description, planSection, codeReference}), totalQuestions (number), criticalCount (number), newQuestionsCount (number), deduplicatedCount (number), droppedAsResolvedCount (number), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['questions', 'totalQuestions', 'criticalCount', 'newQuestionsCount']
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  },
  labels: ['verification', 'merge-dedup', `iteration-${args.iteration}`]
}));

// ============================================================================
// TASK DEFINITIONS — PHASE 2, STEP A.7: PROVE THE GAPS
// ============================================================================

export const proveGapsTask = defineTask('prove-gaps', (args, taskCtx) => ({
  kind: 'agent',
  title: `Prove gaps are real (iteration ${args.iteration})`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Skeptical senior engineer who has seen too many phantom "gaps" waste sprint time. You only act on gaps that are provably real. Your job is to filter out false alarms before they waste the self-answer agent\'s time.',
      task: `For each of the ${(args.questions || {}).totalQuestions || 0} candidate gaps, determine whether it is a genuine gap in the plan or a phantom (something that looks like a gap but is actually already addressed, trivially obvious, or not relevant to this project).`,
      context: {
        planFile: args.planFile,
        projectRoot: args.projectRoot,
        taskDescription: args.taskDescription,
        codebaseScan: args.codebaseScan,
        questions: args.questions,
        iteration: args.iteration
      },
      instructions: [
        `Read the CURRENT plan file: "${args.projectRoot}/${args.planFile}"`,
        '',
        'CANDIDATE GAPS TO EVALUATE:',
        JSON.stringify(args.questions?.questions || [], null, 2),
        '',
        'For each gap, you MUST:',
        '',
        '1. Read the relevant section of the plan again carefully.',
        '2. Search the codebase scan results for evidence (or counter-evidence).',
        '3. Ask: "If a developer implemented this plan exactly as written, would this gap actually cause a problem?"',
        '',
        'A gap is REAL if:',
        '- The plan leaves a concrete decision unmade that a developer would have to guess',
        '- The plan describes behavior that conflicts with existing code patterns',
        '- The plan omits a step that WILL be needed (not just might be)',
        '- The plan would produce subtly wrong behavior in a scenario that is likely to occur',
        '',
        'A gap is PHANTOM if:',
        '- The plan already addresses it (read more carefully before marking real)',
        '- It is a generic concern not specific to this plan (e.g., "add logging" when the codebase already has logging middleware)',
        '- A competent developer would handle it automatically without ambiguity',
        '- It is a "nice to have" that does not affect correctness',
        '- It is a CRITICAL question about a feature that is explicitly out of scope',
        '',
        'For each gap: read actual code files if needed to confirm. A gap that cannot be grounded in specific plan text or specific code evidence is a phantom.',
        '',
        'IMPORTANT: Be genuinely critical. Phantom gaps waste iteration budget. Real gaps must be provably real.',
        '',
        'Return ONLY JSON (no markdown).'
      ],
      outputFormat: 'JSON with questions (array of {id, dimensions, severity, title, description, planSection, codeReference, proofOfRealness: string}), totalProven (number), criticalCount (number), phantomsFiltered (array of {id, title, reason: string}), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['questions', 'totalProven', 'criticalCount', 'phantomsFiltered']
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  },
  labels: ['verification', 'prove-gaps', `iteration-${args.iteration}`]
}));

// ============================================================================
// TASK DEFINITIONS — PHASE 2, STEP B: SELF-ANSWER
// ============================================================================

export const selfAnswerQuestionsTask = defineTask('self-answer-questions', (args, taskCtx) => ({
  kind: 'agent',
  title: `Self-answer questions (iteration ${args.iteration})`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Super senior software developer with 20+ years experience and DEEP, grounded knowledge of THIS EXACT codebase. You have read every file, know every pattern, every gotcha, every integration point. You make decisions based on EVIDENCE from the code, not assumptions. You never take shortcuts or give lazy answers. You reason through trade-offs thoroughly.',
      task: `Answer EVERY proven gap found in iteration ${args.iteration} with the thoroughness and precision of the best engineer on the team. Each answer must be grounded in actual codebase evidence.`,
      context: {
        planFile: args.planFile,
        projectRoot: args.projectRoot,
        taskDescription: args.taskDescription,
        codebaseScan: args.codebaseScan,
        questions: args.questions,
        iteration: args.iteration,
        previousHistory: args.previousHistory
      },
      instructions: [
        `Read the CURRENT plan file: "${args.projectRoot}/${args.planFile}"`,
        '',
        `There are ${args.questions?.totalProven || 0} proven gaps to answer.`,
        '',
        'For EACH question, you MUST:',
        '',
        '1. READ THE RELEVANT CODE. Use Glob and Read tools. Find 2-3 examples of patterns.',
        '',
        '2. REASON THROUGH TRADE-OFFS:',
        '   - At least 2 options with pros/cons',
        '   - What does the existing codebase prefer?',
        '   - What is the simplest correct solution?',
        '',
        '3. GIVE A DEFINITIVE ANSWER. No "it depends". No "TBD". No "we should discuss".',
        '   - Pick the best option. Reference specific files and line numbers.',
        '   - If the answer involves code, write the actual code snippet.',
        '',
        '4. BE GROUNDED. Every answer must cite at least one file path and pattern.',
        '',
        '5. DO NOT BE LAZY. Avoid these:',
        '   - "Just add proper error handling" -> specify EXACTLY what errors and how',
        '   - "Follow existing patterns" -> specify WHICH pattern from WHICH file',
        '   - "Add appropriate tests" -> specify EXACTLY what test cases',
        '   - "Handle edge cases" -> list EACH edge case and handling',
        '   - "Use standard approach" -> specify the EXACT approach with code',
        '',
        '6. PRIORITIZE by severity (CRITICAL first).'
      ],
      outputFormat: 'JSON with answers (array of {questionId, decision, reasoning, codeEvidence (array of {file, snippet, relevance}), tradeOffs (string), implementationDetails (string)}), totalAnswered (number), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['answers', 'totalAnswered', 'summary']
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  },
  labels: ['verification', 'answers', `iteration-${args.iteration}`]
}));

// ============================================================================
// TASK DEFINITIONS — PHASE 2, STEP B.5: 3-JUDGE ANSWER REVIEW
// ============================================================================

export const judgeAnswersTask = defineTask('judge-answers', (args, taskCtx) => ({
  kind: 'agent',
  title: `3-judge answer quality review (iteration ${args.iteration})`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Panel of 3 independent senior engineers reviewing the quality of answers before they are written into the plan. You are strict. A vague or lazy answer that gets written into the plan will cause an implementation agent to make a wrong decision. You prevent that.',
      task: `Review every answer from the self-answer agent. Each answer is evaluated by 3 independent judges. Answers that fail the majority vote (2+ rejections) are marked for revision and returned with specific improvement requirements.`,
      context: {
        planFile: args.planFile,
        projectRoot: args.projectRoot,
        questions: args.questions,
        answers: args.answers,
        iteration: args.iteration
      },
      instructions: [
        `Read the CURRENT plan file: "${args.projectRoot}/${args.planFile}"`,
        '',
        'QUESTIONS AND ANSWERS TO REVIEW:',
        JSON.stringify((args.questions?.questions || []).map(q => {
          const answer = (args.answers?.answers || []).find(a => a.questionId === q.id);
          return { question: q, answer };
        }), null, 2),
        '',
        'For EACH answer, simulate 3 independent judges reviewing it:',
        '',
        'Judge 1 (Implementer): "Can I implement this tomorrow with no further questions?"',
        '  - Is there a specific file to modify?',
        '  - Is there a specific code pattern to follow?',
        '  - Are all edge cases addressed?',
        '',
        'Judge 2 (Skeptic): "Is this answer grounded in actual code evidence?"',
        '  - Does it cite a specific file and line/pattern?',
        '  - Is the decision justified by the existing codebase, not just by convention?',
        '  - Does it avoid vague language ("appropriate", "standard", "similar to")?',
        '',
        'Judge 3 (Completeness): "Does this answer actually resolve the original question?"',
        '  - Does it address ALL sub-points of the question?',
        '  - Does it leave any aspect still ambiguous?',
        '  - Would another reasonable engineer reach the same implementation from this answer?',
        '',
        'Voting: An answer PASSES if at least 2 of 3 judges approve it.',
        'An answer FAILS if 2+ judges reject it.',
        '',
        'For FAILED answers: specify EXACTLY what needs to improve (not "be more specific" — say what specific information is missing).',
        '',
        'For PASSED answers: include them as-is in the approved list.',
        '',
        'Note: Some questions may have no answer if the self-answer agent missed them — flag these as missing.',
        '',
        'Return ONLY JSON (no markdown).'
      ],
      outputFormat: 'JSON with approvedAnswers (array of {questionId, decision, reasoning, codeEvidence, tradeOffs, implementationDetails, votes: {judge1: "approve|reject", judge2: "approve|reject", judge3: "approve|reject"}}), failedAnswers (array of {questionId, votes, rejectionReasons (array of string), requiredImprovements (array of string)}), missingAnswers (array of questionId), totalApproved (number), rejectedCount (number), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['approvedAnswers', 'failedAnswers', 'totalApproved', 'rejectedCount']
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  },
  labels: ['verification', 'judge-answers', `iteration-${args.iteration}`]
}));

// ============================================================================
// TASK DEFINITIONS — PHASE 2, STEP C: UPDATE PLAN
// ============================================================================

export const updatePlanTask = defineTask('update-plan', (args, taskCtx) => ({
  kind: 'agent',
  title: `Update plan file (iteration ${args.iteration})`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Technical writer and plan editor. You integrate decisions into plans with surgical precision.',
      task: `Update the plan file to incorporate ALL approved decisions from verification iteration ${args.iteration}. Only write decisions that passed the 3-judge review.`,
      context: {
        planFile: args.planFile,
        projectRoot: args.projectRoot,
        questions: args.questions,
        answers: args.answers,  // This is now the judge-reviewed answers object
        iteration: args.iteration
      },
      instructions: [
        `Read the CURRENT plan file: "${args.projectRoot}/${args.planFile}"`,
        '',
        'APPROVED ANSWERS TO INCORPORATE:',
        JSON.stringify(args.answers?.approvedAnswers || [], null, 2),
        '',
        `There are ${args.answers?.rejectedCount || 0} rejected answers — do NOT write these to the plan. They did not pass quality review.`,
        '',
        '1. REPLACE vague/ambiguous language with specific decisions from approved answers.',
        '2. ADD missing details in the right section.',
        '3. RESOLVE conflicts by updating contradictory sections.',
        `4. ADD "### Iteration ${args.iteration} Decisions" section at the bottom with a summary of changes.`,
        '5. DO NOT remove existing content unless it directly conflicts with an approved decision.',
        '6. DO NOT restructure — make targeted edits only.',
        '7. Read file AFTER editing to verify changes applied correctly.',
        '',
        'Use Edit tool with exact old_string/new_string. Minimal, targeted changes.'
      ],
      outputFormat: 'JSON with changesApplied (number), changes (array of {section, description, type}), skippedRejectedAnswers (number), planUpdated (boolean), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['changesApplied', 'planUpdated', 'summary']
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  },
  labels: ['verification', 'update', `iteration-${args.iteration}`]
}));

// ============================================================================
// TASK DEFINITIONS — PHASE 2, STEP C.5: CONSISTENCY GATE
// ============================================================================

export const consistencyGateTask = defineTask('consistency-gate', (args, taskCtx) => ({
  kind: 'agent',
  title: `Consistency gate: check for new contradictions (iteration ${args.iteration})`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Meticulous technical editor who reads plans for internal consistency. You are only interested in one thing: did the changes made in this iteration introduce any new contradictions with the existing plan content?',
      task: `Iteration ${args.iteration} just added ${args.planUpdate?.changesApplied || 0} changes to the plan. Check whether any of those additions now conflict with other parts of the plan that existed before.`,
      context: {
        planFile: args.planFile,
        projectRoot: args.projectRoot,
        planUpdate: args.planUpdate,
        iteration: args.iteration
      },
      instructions: [
        `Read the CURRENT plan file: "${args.projectRoot}/${args.planFile}"`,
        '',
        'Changes applied in this iteration:',
        JSON.stringify(args.planUpdate?.changes || [], null, 2),
        '',
        'YOUR ONLY JOB: find contradictions INTRODUCED by this iteration\'s changes.',
        '',
        'Look for:',
        '1. A decision added in this iteration that conflicts with a pre-existing decision elsewhere in the plan',
        '2. A new data structure or API contract that is incompatible with how it was described in a different section',
        '3. A new error handling approach that contradicts the approach already specified in another section',
        '4. A newly specified flow that is impossible given a constraint already in the plan',
        '5. Naming inconsistencies introduced: the same thing called two different things in new vs old sections',
        '',
        'DO NOT report:',
        '- Gaps or missing information (the question-identification step handles those)',
        '- Pre-existing contradictions that were there before this iteration',
        '- Style preferences or formatting issues',
        '',
        'If you find a contradiction, quote both the new text and the conflicting old text. Specify which takes precedence and propose the minimal edit to resolve it.',
        '',
        'If this iteration made no changes (changesApplied = 0), return issuesFound: 0 immediately.',
        '',
        'Return ONLY JSON (no markdown).'
      ],
      outputFormat: 'JSON with issuesFound (number), contradictions (array of {newText: string, conflictingText: string, location1: string, location2: string, severity: "CRITICAL|HIGH|MEDIUM", resolution: string}), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['issuesFound', 'contradictions', 'summary']
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  },
  labels: ['verification', 'consistency-gate', `iteration-${args.iteration}`]
}));

// ============================================================================
// TASK DEFINITIONS — PHASE 2, STEP D: SCORE QUALITY (unchanged)
// ============================================================================

export const scorePlanQualityTask = defineTask('score-plan-quality', (args, taskCtx) => ({
  kind: 'agent',
  title: `Score plan quality (iteration ${args.iteration})`,
  agent: {
    name: 'general-purpose',
    prompt: {
      role: 'Mercilessly strict QA lead and technical reviewer. You score plans with extreme rigor. A 95 means nearly flawless. You do NOT give charity points.',
      task: `Score the plan after ${args.iteration} verification iterations. Target: ${args.qualityThreshold}/100.`,
      context: {
        planFile: args.planFile,
        projectRoot: args.projectRoot,
        taskDescription: args.taskDescription,
        codebaseScan: args.codebaseScan,
        iteration: args.iteration,
        previousHistory: args.previousHistory
      },
      instructions: [
        `Read the CURRENT plan file: "${args.projectRoot}/${args.planFile}"`,
        '',
        'Score on 8 dimensions (0-100 each):',
        '',
        '1. COMPLETENESS (20%) - Every requirement has specific implementation steps?',
        '2. SPECIFICITY (15%) - File paths, function names, data structures defined?',
        '3. CODEBASE_ALIGNMENT (15%) - Follows existing patterns? References actual code?',
        '4. ERROR_HANDLING (10%) - Error cases identified with specific handling?',
        '5. TESTING_STRATEGY (10%) - Specific test cases with assertions?',
        '6. DEPLOYMENT_SAFETY (10%) - Migration, rollback, backward compat?',
        '7. CONSISTENCY (10%) - No internal contradictions?',
        '8. ACTIONABILITY (10%) - Engineer can start immediately?',
        '',
        'Overall = weighted average.',
        '',
        'For each dimension below 90, specify EXACTLY what needs to improve.',
        'BE STRICT.',
        '',
        'Previous scores:',
        JSON.stringify(args.previousHistory?.map(h => ({
          iteration: h.iteration, score: h.score, remainingGaps: h.remainingGaps
        })) || [], null, 2)
      ],
      outputFormat: 'JSON with dimensionScores (object), overallScore (number), remainingGaps (array of {dimension, gap, severity, suggestedFix}), strengths (array of string), summary (string)'
    },
    outputSchema: {
      type: 'object',
      required: ['dimensionScores', 'overallScore', 'remainingGaps', 'summary']
    }
  },
  io: {
    inputJsonPath: `tasks/${taskCtx.effectId}/input.json`,
    outputJsonPath: `tasks/${taskCtx.effectId}/result.json`
  },
  labels: ['verification', 'scoring', `iteration-${args.iteration}`]
}));
