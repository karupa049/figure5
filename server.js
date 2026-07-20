const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 8001);
const ROOT = __dirname;
const RULES_PATH = path.join(ROOT, "rules", "error-rules.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const DEFAULT_TESTS = [
  {
    name: "basic ascending",
    input: "1 2 3 4\n",
    expected: "平均: 2.500000\n平均以上は2個\n",
  },
  {
    name: "same values",
    input: "5 5 5\n",
    expected: "平均: 5.000000\n平均以上は3個\n",
  },
  {
    name: "mixed signs",
    input: "-2 -1 0 10\n",
    expected: "平均: 1.750000\n平均以上は1個\n",
  },
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 200_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const contentType = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs || 3000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error), timedOut: false });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut: signal === "SIGKILL" });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

function normalizeOutput(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

function makeFailure(message, detail) {
  return {
    ok: false,
    message: detail ? `${message}\n${detail}` : message,
  };
}

function normalizeTests(tests) {
  if (!Array.isArray(tests) || tests.length === 0) {
    return DEFAULT_TESTS;
  }

  return tests.map((test, index) => ({
    name: String(test.name || `case ${index + 1}`),
    input: String(test.input || ""),
    expected: typeof test.expected === "string" ? test.expected : undefined,
  }));
}

function countConversions(format) {
  const conversions = format.match(/%(?!%)(?:\*?\d*(?:\.\d+)?[hljztL]*)([diuoxXfFeEgGaAcspn])/g) || [];
  return conversions.filter((conversion) => {
    return !conversion.includes("*") && !conversion.endsWith("n");
  }).length;
}

function isLoopControlledScanf(source, index) {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const beforeOnLine = source.slice(lineStart, index);
  return /\b(while|for)\s*\([^;\n]*$/.test(beforeOnLine);
}

function requiredFixedInputCount(source) {
  const scanfPattern = /scanf\s*\(\s*"((?:\\.|[^"\\])*)"/g;
  const cinPattern = /\b(?:std::)?cin\s*(>>\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*\[[^\]]+\])?\s*)+/g;
  let required = 0;
  let match;

  while ((match = scanfPattern.exec(source))) {
    if (isLoopControlledScanf(source, match.index)) {
      continue;
    }
    required += countConversions(match[1]);
  }

  while ((match = cinPattern.exec(source))) {
    if (isLoopControlledScanf(source, match.index)) {
      continue;
    }
    required += (match[0].match(/>>/g) || []).length;
  }

  return required;
}

function validateTestInputs(source, tests) {
  const required = requiredFixedInputCount(source);
  if (required === 0) {
    return { ok: true };
  }

  for (const test of tests) {
    const tokens = test.input.trim() ? test.input.trim().split(/\s+/) : [];
    if (tokens.length < required) {
      return makeFailure(
        `テスト「${test.name}」の入力が足りません。`,
        `このプログラムは固定の標準入力を少なくとも${required}個必要としますが、このケースは${tokens.length}個です。入力: ${JSON.stringify(test.input)}`,
      );
    }
  }

  return { ok: true };
}

function indentOf(line) {
  return line.match(/^[ \t]*/)?.[0] || "";
}

function ensureIostream(source) {
  if (/#\s*include\s*<iostream>/.test(source)) {
    return source;
  }
  const includePattern = /(^\s*#\s*include\s*<[^>]+>\s*$)/m;
  if (includePattern.test(source)) {
    return source.replace(includePattern, `$1\n#include <iostream>`);
  }
  return `#include <iostream>\n${source}`;
}

function insertCppTraceOutput(source) {
  if (/\[trace\]/.test(source)) {
    return source;
  }

  let traced = ensureIostream(source);
  if (!/\busing\s+namespace\s+std\s*;/.test(traced)) {
    traced = traced.replace(/(^\s*#\s*include\s*<iostream>\s*$)/m, "$1\nusing namespace std;");
  }

  traced = traced.replace(
    /^([ \t]*(?:\w[\w:<>,\s*&]*\s+)?sum\s*=\s*[^;\n]+;\s*)$/gm,
    (line) => `${line}\n${indentOf(line)}cout << "[trace] sum=" << sum << endl;`,
  );
  traced = traced.replace(
    /^([ \t]*(?:\w[\w:<>,\s*&]*\s+)?size\s*=\s*[^;\n]+;\s*)$/gm,
    (line) => `${line}\n${indentOf(line)}cout << "[trace] size=" << size << endl;`,
  );
  traced = traced.replace(
    /^([ \t]*(?:\w[\w:<>,\s*&]*\s+)?avr\s*=\s*[^;\n]+;\s*)$/gm,
    (line) => `${line}\n${indentOf(line)}cout << "[trace] avr=" << avr << endl;`,
  );
  traced = traced.replace(
    /^([ \t]*for\s*\(\s*(?:const\s+)?(?:auto|int|double|float|char|long|short|[A-Za-z_:][A-Za-z0-9_:<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[^)]*\)\s*\{\s*)$/gm,
    (line, _full, itemName) => `${line}\n${indentOf(line)}  cout << "[trace] ${itemName}=" << ${itemName} << " count=" << count << endl;`,
  );
  traced = traced.replace(
    /^([ \t]*(?:count\s*(?:\+\+|--|\+=\s*[^;\n]+|-=\s*[^;\n]+)|count\s*=\s*[^;\n]*\bcount\b[^;\n]*)\s*;\s*)$/gm,
    (line) => `${line}\n${indentOf(line)}cout << "[trace] count=" << count << endl;`,
  );

  // 元からある printf の前に [trace] を挿入する
  traced = traced.replace(
    /^([ \t]*)((?:std::)?printf\s*\(.*)$/gm,
    (line, indent, rest) => {
      if (line.includes("[trace]") || /^[ \t]*\/\//.test(line)) return line;
      return `${indent}cout << "[trace] "; ${rest}`;
    }
  );

  // 元からある cout の前に [trace] を挿入する
  traced = traced.replace(
    /^([ \t]*)((?:std::)?cout\s*<<.*)$/gm,
    (line, indent, rest) => {
      if (line.includes("[trace]") || /^[ \t]*\/\//.test(line)) return line;
      return `${indent}cout << "[trace] "; ${rest}`;
    }
  );

  return traced;
}

function traceLineLabels(source) {
  return source.split("\n").reduce((labels, line, index) => {
    if (/\bcout\s*<<\s*"\[trace\]/.test(line)) {
      labels.push(`L${index + 1}`);
    }
    return labels;
  }, []);
}

function applyTraceLabels(source, labels) {
  let traceIndex = 0;
  return source.replace(/"\[trace\]/g, (match) => {
    const label = labels[traceIndex];
    traceIndex++;
    return label ? `"[trace ${label}]` : match;
  });
}

async function makeInstrumentedExercise(source, correctSource, rawTests) {
  if (!looksLikeCpp(source) || !looksLikeCpp(correctSource)) {
    return makeFailure("coutヒントはC++コード向けです。Cコードの場合はC++版の正解コードで試してください。");
  }

  const rawInstrumentedSource = insertCppTraceOutput(source);
  const labels = traceLineLabels(rawInstrumentedSource);
  const instrumentedSource = applyTraceLabels(rawInstrumentedSource, labels);
  const instrumentedCorrectSource = applyTraceLabels(insertCppTraceOutput(correctSource), labels);
  const expected = await makeExpectedTests(instrumentedCorrectSource, rawTests);
  if (!expected.ok) {
    return expected;
  }

  return {
    ok: true,
    source: instrumentedSource,
    tests: expected.tests,
    message: "cout入りの問題と期待出力を生成しました。",
  };
}

function looksLikeCpp(source) {
  return /#\s*include\s*<(?:iostream|bits\/stdc\+\+\.h|vector|string|algorithm|map|set|queue|stack)>/.test(source)
    || /\b(?:std::|using\s+namespace\s+std\b|cin\s*>>|cout\s*<<|class\s+\w+|template\s*<)/.test(source);
}

function compileAttemptsFor(source, tmpDir, exePath) {
  const cAttempt = {
    language: "C",
    sourcePath: path.join(tmpDir, "answer.c"),
    command: "docker",
    args: [
      "run", "--rm",
      "-v", `${tmpDir}:/src`,
      "-w", "/src",
      "gcc",
      "gcc", "-std=c11", "-Wall", "-Wextra", "answer.c", "-o", "answer"
    ],
  };
  const cppAttempt = {
    language: "C++",
    sourcePath: path.join(tmpDir, "answer.cpp"),
    command: "docker",
    args: [
      "run", "--rm",
      "-v", `${tmpDir}:/src`,
      "-w", "/src",
      "gcc",
      "g++", "-std=c++17", "-Wall", "-Wextra", "answer.cpp", "-o", "answer"
    ],
  };

  return looksLikeCpp(source) ? [cppAttempt, cAttempt] : [cAttempt, cppAttempt];
}

async function compileSource(source, tmpPrefix = "exercise-") {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("C/C++ソースが空です。");
  }

  const tmpParent = path.join(ROOT, "tmp");
  if (!fs.existsSync(tmpParent)) {
    fs.mkdirSync(tmpParent, { recursive: true });
  }
  const tmpDir = await fs.promises.mkdtemp(path.join(tmpParent, tmpPrefix));
  const exePath = path.join(tmpDir, "answer");
  const failures = [];

  for (const attempt of compileAttemptsFor(source, tmpDir, exePath)) {
    await fs.promises.writeFile(attempt.sourcePath, source, "utf8");
    const compile = await runCommand(attempt.command, attempt.args, { cwd: tmpDir, timeoutMs: 10000 });

    if (compile.code === 0) {
      return { tmpDir, exePath, language: attempt.language };
    }

    const detail = compile.stderr.trim() || compile.stdout.trim() || `${attempt.command} を実行できませんでした。`;
    failures.push(`${attempt.language} (${attempt.command})\n${detail}`);
  }

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
  throw new Error(`C/C++どちらのコンパイルにも失敗しました。\n${failures.join("\n\n")}`);
}

async function runTests(exePath, tmpDir, tests) {
  const results = [];
  for (const test of tests) {
    const run = await runCommand("docker", [
      "run", "--rm", "-i",
      "-v", `${tmpDir}:/src`,
      "-w", "/src",
      "gcc",
      "./answer"
    ], {
      cwd: tmpDir,
      input: test.input,
      timeoutMs: 5000,
    });

    if (run.timedOut) {
      return makeFailure(`テスト「${test.name}」が時間切れになりました。`);
    }
    if (run.code !== 0) {
      return makeFailure(
        `テスト「${test.name}」の実行に失敗しました。`,
        run.stderr.trim(),
      );
    }
    results.push({ ...test, actual: run.stdout });
  }

  return { ok: true, results };
}

async function checkSource(source, rawTests) {
  const tests = normalizeTests(rawTests);
  let compiled;

  try {
    compiled = await compileSource(source, "check-");
    const runResult = await runTests(compiled.exePath, compiled.tmpDir, tests);
    if (!runResult.ok) {
      return runResult;
    }

    for (const result of runResult.results) {
      if (normalizeOutput(result.actual) !== normalizeOutput(result.expected || "")) {
        return {
          ok: false,
          message: `テスト「${result.name}」の出力が期待と異なります。`,
          tests: runResult.results.map((item) => ({
            name: item.name,
            input: item.input,
            expected: item.expected || "",
            actual: item.actual,
            passed: normalizeOutput(item.actual) === normalizeOutput(item.expected || ""),
          })),
        };
      }
    }

    return {
      ok: true,
      message: `正解です。${tests.length}件のテストで期待通りの出力になりました。`,
      tests: runResult.results.map((result) => ({
        name: result.name,
        input: result.input,
        expected: result.expected || "",
        actual: result.actual,
        passed: true,
      })),
    };
  } catch (error) {
    return makeFailure(error.message);
  } finally {
    if (compiled) {
      await fs.promises.rm(compiled.tmpDir, { recursive: true, force: true });
    }
  }
}

async function makeExpectedTests(source, rawTests) {
  const tests = normalizeTests(rawTests).map((test) => ({
    name: test.name,
    input: test.input,
  }));
  const inputValidation = validateTestInputs(source, tests);
  if (!inputValidation.ok) {
    return inputValidation;
  }
  let compiled;

  try {
    compiled = await compileSource(source, "generate-");
    const runResult = await runTests(compiled.exePath, compiled.tmpDir, tests);
    if (!runResult.ok) {
      return runResult;
    }
    return {
      ok: true,
      tests: runResult.results.map((test) => ({
        name: test.name,
        input: test.input,
        expected: test.actual,
      })),
    };
  } catch (error) {
    return makeFailure(error.message);
  } finally {
    if (compiled) {
      await fs.promises.rm(compiled.tmpDir, { recursive: true, force: true });
    }
  }
}

function loadRules() {
  const raw = fs.readFileSync(RULES_PATH, "utf8");
  const config = JSON.parse(raw);
  return (config.rules || []).filter((rule) => rule.enabled !== false);
}

function shuffle(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function expandReplacement(template, match) {
  return template.replace(/\$(\d+)/g, (_, index) => match[Number(index)] || "");
}

function collectVariableNames(source) {
  const names = new Set();
  const declarationPattern = /\b(?:int|double|float|char|long|short)\s+([^;]+);/g;
  let declaration;

  while ((declaration = declarationPattern.exec(source))) {
    for (const rawPart of declaration[1].split(",")) {
      const name = rawPart
        .replace(/\[[^\]]*\]/g, "")
        .replace(/=.*/, "")
        .replace(/[*&]/g, "")
        .trim()
        .match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0];
      if (name) {
        names.add(name);
      }
    }
  }

  return [...names];
}

function mutationFromVariableRule(source, rule) {
  const variables = collectVariableNames(source);
  const flags = rule.flags || "";
  const regex = new RegExp(rule.pattern, flags.includes("g") ? flags : `${flags}g`);
  const candidates = [];
  let match;

  while ((match = regex.exec(source))) {
    const groupIndex = rule.group || 1;
    const captured = match[groupIndex];
    if (typeof captured !== "string") {
      continue;
    }

    const localStart = match[0].indexOf(captured);
    if (localStart < 0) {
      continue;
    }

    const start = match.index + localStart;
    const end = start + captured.length;
    for (const variable of variables) {
      if (variable === captured) {
        continue;
      }
      candidates.push({
        start,
        end,
        initial: variable,
        note: `${rule.title}: ${rule.description}`,
        ruleId: rule.id,
        ruleTitle: rule.title,
        paperRule: rule.paperRule,
      });
    }
  }

  return candidates;
}

function mutationFromRule(source, rule) {
  if (rule.operation === "replace-with-variable") {
    return mutationFromVariableRule(source, rule);
  }

  const flags = rule.flags || "";
  const regex = new RegExp(rule.pattern, flags.includes("g") ? flags : `${flags}g`);
  const candidates = [];
  let match;

  while ((match = regex.exec(source))) {
    const groupIndex = rule.group || 0;
    const captured = match[groupIndex];
    if (typeof captured !== "string") {
      continue;
    }

    const localStart = groupIndex === 0 ? 0 : match[0].indexOf(captured);
    if (localStart < 0) {
      continue;
    }

    let replacement = rule.replacement ?? "";
    if (Array.isArray(rule.variants)) {
      const variant = rule.variants.find((item) => item.from === captured);
      if (!variant) {
        continue;
      }
      replacement = variant.to;
    }

    const start = match.index + localStart;
    const end = start + captured.length;
    if (start === end && replacement === "") {
      continue;
    }

    candidates.push({
      start,
      end,
      initial: expandReplacement(replacement, match),
      note: `${rule.title}: ${rule.description}`,
      ruleId: rule.id,
      ruleTitle: rule.title,
      paperRule: rule.paperRule,
    });
  }

  return candidates;
}

function buildMutatedSource(source, mutations) {
  let mutated = "";
  let cursor = 0;
  for (const mutation of [...mutations].sort((a, b) => a.start - b.start)) {
    mutated += source.slice(cursor, mutation.start);
    mutated += mutation.initial;
    cursor = mutation.end;
  }
  mutated += source.slice(cursor);
  return mutated;
}

async function producesSemanticFailure(source, expectedTests, mutations) {
  const mutatedSource = buildMutatedSource(source, mutations);
  let compiled;

  try {
    compiled = await compileSource(mutatedSource, "candidate-");
    const runResult = await runTests(compiled.exePath, compiled.tmpDir, expectedTests);
    if (!runResult.ok) {
      return false;
    }
    return runResult.results.some((result) => {
      return normalizeOutput(result.actual) !== normalizeOutput(result.expected || "");
    });
  } catch (error) {
    return false;
  } finally {
    if (compiled) {
      await fs.promises.rm(compiled.tmpDir, { recursive: true, force: true });
    }
  }
}

async function findSemanticMutations(source, expectedTests, options = {}) {
  const maxRules = Math.max(1, Math.min(Number(options.maxRules || 4), 12));
  const random = Math.random;
  const rules = shuffle(loadRules(), random);
  const mutations = [];
  const occupied = [];

  for (const rule of rules) {
    const candidates = shuffle(mutationFromRule(source, rule), random);
    for (const candidate of candidates) {
      const overlaps = occupied.some(([a, b]) => candidate.start < b && candidate.end > a);
      if (overlaps) {
        continue;
      }

      const worksAlone = await producesSemanticFailure(source, expectedTests, [candidate]);
      if (!worksAlone) {
        continue;
      }

      const trial = [...mutations, candidate];
      const worksTogether = await producesSemanticFailure(source, expectedTests, trial);
      if (!worksTogether) {
        continue;
      }

      occupied.push([candidate.start, candidate.end]);
      mutations.push({
        id: `e${mutations.length + 1}`,
        ...candidate,
      });
      break;
    }

    if (mutations.length >= maxRules) {
      break;
    }
  }

  return mutations.sort((a, b) => a.start - b.start);
}

function makeExerciseParts(source, mutations) {
  if (mutations.length === 0) {
    return null;
  }

  const parts = [];
  let cursor = 0;
  for (const mutation of mutations) {
    parts.push(source.slice(cursor, mutation.start));
    parts.push({
      id: mutation.id,
      initial: mutation.initial,
      note: mutation.note,
    });
    cursor = mutation.end;
  }
  parts.push(source.slice(cursor));
  return { parts, slots: mutations };
}

async function generateExercise(source, tests, options = {}) {
  const expected = await makeExpectedTests(source, tests);
  if (!expected.ok) {
    return expected;
  }

  const mutations = await findSemanticMutations(source, expected.tests, options);
  const injected = makeExerciseParts(source, mutations);
  if (!injected) {
    return makeFailure("コンパイルは通るが出力が変わる誤りを生成できませんでした。テスト入力を増やすか、for文・比較式・再帰などを含むC/C++コードで試してください。");
  }

  return {
    ok: true,
    parts: injected.parts,
    slots: injected.slots,
    tests: expected.tests,
    message: `${injected.slots.length}個の編集可能箇所を生成しました。`,
  };
}

const LOGS_DIR = path.join(ROOT, "logs");
const LOG_FILE = path.join(LOGS_DIR, "study-log.jsonl");

async function handleLogRequest(payload) {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(payload) + "\n", "utf8");
  } catch (err) {
    console.error("Failed to write local log:", err);
  }

  const gasUrl = process.env.GAS_WEBAPP_URL;
  if (gasUrl) {
    try {
      const response = await fetch(gasUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        console.error(`GAS log forwarding failed with status ${response.status}`);
      }
    } catch (err) {
      console.error("Failed to forward log to GAS:", err);
    }
  }

  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  console.log(`[Request] ${req.method} ${req.url}`);
  if (req.method === "POST" && req.url === "/api/check") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      sendJson(res, 200, await checkSource(payload.source, payload.tests));
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        message: `判定リクエストを処理できませんでした: ${error.message}`,
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/generate") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      sendJson(res, 200, await generateExercise(payload.source, payload.tests, payload.options));
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        message: `生成リクエストを処理できませんでした: ${error.message}`,
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/instrument") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      sendJson(res, 200, await makeInstrumentedExercise(payload.source, payload.correctSource, payload.tests));
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        message: `coutヒント生成リクエストを処理できませんでした: ${error.message}`,
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/log") {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body);
      const resData = await handleLogRequest(payload);
      sendJson(res, 200, resData);
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        message: `ログリクエストを処理できませんでした: ${error.message}`,
      });
    }
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }

  const requestedPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url);
  const filePath = path.normalize(path.join(ROOT, requestedPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
  sendFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`Figure 5 prototype running at http://localhost:${PORT}`);
});
