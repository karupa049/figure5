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
  let required = 0;
  let match;

  while ((match = scanfPattern.exec(source))) {
    if (isLoopControlledScanf(source, match.index)) {
      continue;
    }
    required += countConversions(match[1]);
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
        `このプログラムは固定のscanf入力を少なくとも${required}個必要としますが、このケースは${tokens.length}個です。入力: ${JSON.stringify(test.input)}`,
      );
    }
  }

  return { ok: true };
}

async function compileSource(source, tmpPrefix = "exercise-") {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("Cソースが空です。");
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), tmpPrefix));
  const sourcePath = path.join(tmpDir, "answer.c");
  const exePath = path.join(tmpDir, "answer");

  await fs.promises.writeFile(sourcePath, source, "utf8");
  const compile = await runCommand(
    "gcc",
    ["-std=c11", "-Wall", "-Wextra", sourcePath, "-o", exePath],
    { cwd: tmpDir, timeoutMs: 5000 },
  );

  if (compile.code !== 0) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    const detail = compile.stderr.trim();
    throw new Error(detail ? `コンパイルに失敗しました。\n${detail}` : "コンパイルに失敗しました。");
  }

  return { tmpDir, exePath };
}

async function runTests(exePath, tmpDir, tests) {
  const results = [];
  for (const test of tests) {
    const run = await runCommand(exePath, [], {
      cwd: tmpDir,
      input: test.input,
      timeoutMs: 2000,
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

function seededRandom(seedText) {
  let seed = 2166136261;
  for (let index = 0; index < seedText.length; index++) {
    seed ^= seedText.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
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
  const seed = String(options.seed || `${Date.now()}-${Math.random()}`);
  const random = seededRandom(seed);
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
    return makeFailure("コンパイルは通るが出力が変わる誤りを生成できませんでした。テスト入力を増やすか、for文・比較式・再帰などを含むCコードで試してください。");
  }

  return {
    ok: true,
    parts: injected.parts,
    slots: injected.slots,
    tests: expected.tests,
    message: `${injected.slots.length}個の編集可能箇所を生成しました。`,
  };
}

const server = http.createServer(async (req, res) => {
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
