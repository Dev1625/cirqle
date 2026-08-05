import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  AI_FEATURE_IDS,
  AI_FEATURE_POLICIES,
  AI_MODEL_ALIASES_BY_TIER,
  PRODUCTION_MODEL_ALIASES,
  getAIFeaturePolicy,
} from '../api/_lib/ai-feature-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = path.join(ROOT, 'src');

const EXPECTED_POLICIES = {
  'dashboard-weekly-priorities': [
    'reasoning',
    'deepseek-v4-flash',
    500,
    0.4,
    'Weekly priorities',
  ],
  'global-natural-language-search': [
    'reasoning',
    'deepseek-v4-flash',
    800,
    0.4,
    'Natural-language directory search',
  ],
  'pre-meeting-brief': [
    'reasoning',
    'deepseek-v4-flash',
    700,
    0.4,
    'Pre-meeting brief',
  ],
  'dormant-revival-draft': [
    'reasoning',
    'deepseek-v4-flash',
    450,
    0.4,
    'Dormant contact revival',
  ],
  'commitment-extraction': [
    'reasoning',
    'deepseek-v4-flash',
    900,
    0.4,
    'Commitment extraction',
  ],
  'digital-card-draft': [
    'draft',
    'deepseek-v4-pro',
    450,
    0.4,
    'Digital card draft',
  ],
  'voice-memo-summary': [
    'fast',
    'gemini-3.5-flash-lite',
    120,
    0.4,
    'Voice memo summary',
  ],
  'directory-csv-import': [
    'fast',
    'gemini-3.5-flash-lite',
    3_200,
    0.4,
    'CSV contact import',
  ],
  'directory-contact-parse': [
    'fast',
    'gemini-3.5-flash-lite',
    700,
    0.4,
    'Pasted contact parsing',
  ],
  'contact.reply.process': [
    'reasoning',
    'deepseek-v4-flash',
    350,
    0.1,
    'Reply processing',
  ],
  'contact.tags.extract': [
    'fast',
    'gemini-3.5-flash-lite',
    700,
    0,
    'Conversation tag extraction',
  ],
  'contact.outreach.draft.quick': [
    'fast',
    'gemini-3.5-flash-lite',
    550,
    0.2,
    'Quick outreach draft',
  ],
  'contact.outreach.draft.premium': [
    'draft',
    'deepseek-v4-pro',
    900,
    0.2,
    'Premium outreach draft',
  ],
  'production-signup-smoke': [
    'fast',
    'gemini-3.5-flash-lite',
    8,
    0,
    'Production signup smoke test',
  ],
};

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

function getProperty(objectLiteral, name) {
  return objectLiteral.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (property.name.getText().replace(/^['"]|['"]$/g, '') === name),
  );
}

function outreachFeatureConstants() {
  const source = fs.readFileSync(
    path.join(SRC_ROOT, 'lib', 'outreachWorkflow.ts'),
    'utf8',
  );
  const block = source.match(
    /OUTREACH_AI_FEATURES\s*=\s*\{([\s\S]*?)\}\s*as const/,
  )?.[1];
  assert.ok(block, 'OUTREACH_AI_FEATURES must remain statically inspectable.');
  return Object.fromEntries(
    Array.from(
      block.matchAll(/^\s*(\w+):\s*'([^']+)'/gm),
      (match) => [match[1], match[2]],
    ),
  );
}

function featureIdsFromExpression(node, constants) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    node.expression.getText() === 'OUTREACH_AI_FEATURES'
  ) {
    const feature = constants[node.name.text];
    assert.ok(feature, `Unknown outreach feature constant: ${node.name.text}`);
    return [feature];
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...featureIdsFromExpression(node.whenTrue, constants),
      ...featureIdsFromExpression(node.whenFalse, constants),
    ];
  }
  if (ts.isParenthesizedExpression(node)) {
    return featureIdsFromExpression(node.expression, constants);
  }
  assert.fail(
    `AI feature expressions must be statically auditable, received: ${node.getText()}`,
  );
}

function inspectProductCalls() {
  const constants = outreachFeatureConstants();
  const calls = [];
  const bypasses = [];

  for (const absolute of sourceFiles(SRC_ROOT)) {
    const relative = path.relative(ROOT, absolute).replaceAll('\\', '/');
    const sourceText = fs.readFileSync(absolute, 'utf8');
    const sourceFile = ts.createSourceFile(
      absolute,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      absolute.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const called = node.expression.text;
        if (
          ['generateJSON', 'generateText', 'chat'].includes(called) &&
          !['src/lib/ai.ts', 'src/lib/grounding.ts'].includes(relative)
        ) {
          bypasses.push(`${relative}:${sourceFile.getLineAndCharacterOfPosition(node.pos).line + 1}`);
        }

        if (
          ['generateGroundedJSON', 'generateGroundedText'].includes(called) &&
          relative !== 'src/lib/grounding.ts'
        ) {
          const params = node.arguments[0];
          assert.ok(
            params && ts.isObjectLiteralExpression(params),
            `${relative} must pass an inline grounded-generation request.`,
          );
          const optionsProperty = getProperty(params, 'options');
          assert.ok(
            optionsProperty &&
              ts.isPropertyAssignment(optionsProperty) &&
              ts.isObjectLiteralExpression(optionsProperty.initializer),
            `${relative} must include inline AI options.`,
          );
          const featureProperty = getProperty(
            optionsProperty.initializer,
            'feature',
          );
          assert.ok(
            featureProperty && ts.isPropertyAssignment(featureProperty),
            `${relative} has a model call without feature attribution.`,
          );
          calls.push({
            relative,
            features: featureIdsFromExpression(
              featureProperty.initializer,
              constants,
            ),
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  return { calls, bypasses };
}

test('the feature registry is the exact reviewed model and limit contract', () => {
  assert.deepEqual(
    [...AI_FEATURE_IDS].sort(),
    Object.keys(EXPECTED_POLICIES).sort(),
  );
  assert.deepEqual(AI_MODEL_ALIASES_BY_TIER, {
    fast: 'gemini-3.5-flash-lite',
    reasoning: 'deepseek-v4-flash',
    draft: 'deepseek-v4-pro',
  });
  assert.deepEqual(PRODUCTION_MODEL_ALIASES, [
    'gemini-3.5-flash-lite',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
  ]);

  for (const [feature, expected] of Object.entries(EXPECTED_POLICIES)) {
    const policy = getAIFeaturePolicy(feature);
    assert.ok(policy, `Missing policy for ${feature}`);
    assert.deepEqual(
      [
        policy.tier,
        policy.modelAlias,
        policy.maxOutputTokens,
        policy.maxTemperature,
        policy.label,
      ],
      expected,
    );
    assert.equal(policy.defaultMaxTokens, policy.maxOutputTokens);
    assert.equal(policy.sendsTemperature, policy.tier !== 'fast');
    assert.ok(policy.group);
    assert.equal(Object.isFrozen(policy), true);
  }
  assert.equal(getAIFeaturePolicy('unattributed'), null);
  assert.equal(getAIFeaturePolicy('made-up-feature'), null);
});

test('every product generation call is grounded, attributed, and registered', () => {
  const { calls, bypasses } = inspectProductCalls();
  assert.deepEqual(bypasses, []);
  assert.equal(
    calls.length,
    12,
    'Review the policy whenever a product model call is added or removed.',
  );

  const featuresAtCallSites = new Set(
    calls.flatMap((call) => call.features),
  );
  const registeredProductFeatures = new Set(
    AI_FEATURE_IDS.filter((feature) => feature !== 'production-signup-smoke'),
  );
  assert.deepEqual(
    [...featuresAtCallSites].sort(),
    [...registeredProductFeatures].sort(),
  );
});

test('the only non-product call is the exact bounded production smoke request', () => {
  const smoke = fs.readFileSync(
    path.join(ROOT, 'scripts', 'smoke-production-signup.mjs'),
    'utf8',
  );
  const policy = AI_FEATURE_POLICIES['production-signup-smoke'];

  assert.equal(policy.synthetic, true);
  assert.equal(policy.exactPrompt, 'Reply with only OK.');
  assert.match(smoke, /feature:\s*'production-signup-smoke'/);
  assert.match(smoke, /prompt:\s*'Reply with only OK\.'/);
  assert.match(smoke, /temperature:\s*0/);
  assert.match(smoke, /maxTokens:\s*8/);
  assert.match(
    smoke,
    /requiredEnv\(\s*'LITELLM_KEY_DERIVATION_SECRET'/,
  );
  assert.equal(
    (
      smoke.match(
        /^\s*feature:\s*'production-signup-smoke'/gm,
      ) || []
    ).length,
    1,
  );
  assert.equal(
    (
      smoke.match(
        /^\s*cirqle_feature:\s*'production-signup-smoke'/gm,
      ) || []
    ).length,
    1,
  );
  assert.match(
    smoke,
    /for\s*\(\s*const alias of PRODUCTION_MODEL_ALIASES\.slice\(1\)\s*\)/,
  );
  assert.match(smoke, /assertAttributedUsage\(\{\s*baseUrl,\s*token: idToken\s*\}\)/);
});
