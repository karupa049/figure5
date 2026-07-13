// アプリ起動時のID確認・生成と時間測定用変数
function generateUUID() {
  return "usr-" + Math.random().toString(36).substring(2, 10);
}

let terminalId = localStorage.getItem("terminalId");
if (!terminalId) {
  terminalId = generateUUID();
  localStorage.setItem("terminalId", terminalId);
}

let studentId = localStorage.getItem("studentId");
if (!studentId) {
  studentId = prompt("学習用の学籍番号（またはID）を入力してください。\n※次回からは自動入力されます。");
  if (studentId) {
    studentId = studentId.trim();
    localStorage.setItem("studentId", studentId);
  } else {
    studentId = "anonymous-" + generateUUID().split("-")[1];
    localStorage.setItem("studentId", studentId);
  }
}

let sessionStartTime = null;
let hintStartTime = null;

async function sendLog(event, extraData = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    event: event,
    studentId: studentId,
    terminalId: terminalId,
    source: buildSource(),
    ...extraData
  };
  try {
    await fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error("Failed to send log:", e);
  }
}

const correctSourceInput = document.querySelector("#correctSource");
const testsInput = document.querySelector("#testsInput");
const generateButton = document.querySelector("#generateButton");
const debugButton = document.querySelector("#debugButton");
const maxRulesInput = document.querySelector("#maxRules");
const exercise = document.querySelector("#exercise");
const result = document.querySelector("#result");
const score = document.querySelector("#score");
const codeLineTemplate = document.querySelector("#codeLineTemplate");
const guideText = document.querySelector("#guideText");
const guidePrev = document.querySelector("#guidePrev");
const guideNext = document.querySelector("#guideNext");

const guideSteps = [
  {
    target: "source",
    text: "正しく動くC/C++プログラムを貼り付けます。すでに誤りが入ったコードではなく、正解コードを入れてください。",
  },
  {
    target: "tests",
    text: "標準入力として渡す入力例を書きます。複数ケースは --- だけの行で区切ります。",
  },
  {
    target: "options",
    text: "最大誤り数を決めます。指定数は上限なので、条件に合う候補が少ない場合は少なめに生成されます。",
  },
  {
    target: "generate",
    text: "問題生成を押すと、正解コードの期待出力を作り、出力が変わる誤りだけを埋め込みます。",
  },
  {
    target: "exercise",
    text: "生成された問題です。上から順にコードを読み、正しいと思った行にチェックを入れながら必要な箇所を修正します。",
  },
  {
    target: "check",
    text: "修正できたと思ったら解答を押します。各テストの入力、期待出力、実際の出力が表示されます。",
  },
];

const defaultCorrectSource = `/* ************************************
次の
「ファイル内のすべての整数データを
配列に読み込みながら平均値を求め，
配列内の平均値以上のデータの個数を
表示するプログラム」
の誤りを訂正しなさい．
************************************ */

#include <stdio.h>
#define MAXSIZE 128

int main(void)
{
  int data[MAXSIZE];
  int size, sum, count, i;
  double avr;

  sum = 0;
  size = 0;
  while (scanf("%d", &data[size]) != EOF) {
    sum += data[size];
    size++;
  }

  avr = (double) sum / size;
  printf("平均: %f\\n", avr);
  count = 0;

  for (i = 0; i < size; i++) {
    if (data[i] >= avr) {
      count++;
    }
  }
  printf("平均以上は%d個\\n", count);

  return 0;
}
`;

const defaultTests = `1 2 3 4
---
5 5 5
---
-2 -1 0 10`;

let exerciseParts = [];
let activeTests = [];
let guideIndex = 0;
let exerciseHasTrailingNewline = true;
const codeLineById = new Map();

function guideTarget(step) {
  return document.querySelector(`[data-guide-target="${step.target}"]`);
}

function setGuideStep(index) {
  guideIndex = Math.max(0, Math.min(index, guideSteps.length - 1));
  document.querySelectorAll(".guide-highlight").forEach((node) => {
    node.classList.remove("guide-highlight");
  });

  const step = guideSteps[guideIndex];
  const target = guideTarget(step);
  guideText.textContent = step.text;
  guidePrev.disabled = guideIndex === 0;
  guideNext.textContent = guideIndex === guideSteps.length - 1 ? "最初へ" : "次へ";

  if (target) {
    target.classList.add("guide-highlight");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function advanceGuideTo(targetName) {
  const index = guideSteps.findIndex((step) => step.target === targetName);
  if (index >= 0 && index > guideIndex) {
    setGuideStep(index);
  }
}

function parseTests(text) {
  return text
    .split(/\n---+\n/g)
    .map((input) => input.trim())
    .filter(Boolean)
    .map((input, index) => ({
      name: `case ${index + 1}`,
      input: `${input}\n`,
    }));
}

function resetStatus(message = "上から順に確認し、OKだと思った行にチェックを入れられます。") {
  score.textContent = "未採点";
  result.className = "result";
  renderCasePanel({
    message,
    tests: activeTests,
    showActual: false,
  });
}

function partsToSource(parts) {
  return parts.map((part) => (typeof part === "string" ? part : part.initial)).join("");
}

function updateTraceLineState(row, text) {
  row.classList.toggle("trace-line", /\bcout\s*<<\s*"\[trace(?:\s+L\d+)?\]/.test(text));
}

function makeCodeLine(text, index) {
  const row = codeLineTemplate.content.firstElementChild.cloneNode(true);
  const reviewButton = row.querySelector(".line-review");
  const lineNumber = row.querySelector(".line-number");
  const lineCode = row.querySelector(".line-code");
  const lineId = `l${index + 1}`;

  row.dataset.id = lineId;
  lineNumber.textContent = index + 1;
  reviewButton.title = `${index + 1}行目をOKにする`;
  reviewButton.setAttribute("aria-label", `${index + 1}行目をOKにする`);
  renderCodeLineWithHiddenTrace(lineCode, text);
  updateTraceLineState(row, text);

  reviewButton.addEventListener("click", () => {
    const reviewed = row.classList.toggle("reviewed");
    reviewButton.setAttribute("aria-pressed", String(reviewed));
    reviewButton.title = reviewed ? `${index + 1}行目のOKを外す` : `${index + 1}行目をOKにする`;
    reviewButton.setAttribute("aria-label", reviewButton.title);
  });
  lineCode.addEventListener("input", () => {
    row.classList.remove("reviewed");
    reviewButton.setAttribute("aria-pressed", "false");
    updateTraceLineState(row, lineCode.textContent);
    resetStatus();
  });
  lineCode.addEventListener("focus", () => row.classList.add("active"));
  lineCode.addEventListener("blur", () => row.classList.remove("active"));

  codeLineById.set(lineId, lineCode);
  return row;
}

function renderExercise(parts) {
  exerciseParts = parts;
  codeLineById.clear();
  exercise.replaceChildren();

  const source = partsToSource(parts).replace(/\r\n/g, "\n");
  exerciseHasTrailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (exerciseHasTrailingNewline) {
    lines.pop();
  }

  lines.forEach((line, index) => {
    exercise.append(makeCodeLine(line, index));
  });
}

function buildSource() {
  const source = [...codeLineById.values()].map((line) => line.textContent).join("\n");
  return exerciseHasTrailingNewline ? `${source}\n` : source;
}

function renderCasePanel(payload) {
  result.replaceChildren();

  const summary = document.createElement("p");
  summary.className = "result-summary";
  summary.textContent = payload.message;
  result.append(summary);

  if (!Array.isArray(payload.tests) || payload.tests.length === 0) {
    return;
  }

  const list = document.createElement("div");
  list.className = "test-results";

  for (const test of payload.tests) {
    const item = document.createElement("section");
    item.className = "test-result";
    if (test.passed === false) {
      item.classList.add("failed");
    }

    const title = document.createElement("h3");
    title.textContent = test.name;

    const inputLabel = document.createElement("span");
    inputLabel.textContent = "入力";
    const input = document.createElement("pre");
    input.textContent = test.input.trimEnd();

    item.append(title, inputLabel, input);

    const comparison = document.createElement("div");
    comparison.className = "output-comparison";

    const expectedPane = document.createElement("div");
    expectedPane.className = "output-pane";
    const expectedLabel = document.createElement("span");
    expectedLabel.textContent = "期待される出力";
    const expected = document.createElement("pre");
    renderOutputText(expected, test.expected || "");
    expectedPane.append(expectedLabel, expected);
    comparison.append(expectedPane);

    if (payload.showActual && test.actual !== undefined) {
      const actualPane = document.createElement("div");
      actualPane.className = "output-pane";
      const actualLabel = document.createElement("span");
      actualLabel.textContent = "実際の出力";
      const actual = document.createElement("pre");
      renderOutputText(actual, test.actual);
      actualPane.append(actualLabel, actual);
      comparison.append(actualPane);
    }

    item.append(comparison);
    list.append(item);
  }

  result.append(list);
}

async function generateExercise(options = {}) {
  if (!options.silentGuide) {
    advanceGuideTo("generate");
  }
  score.textContent = "生成中";
  debugButton.disabled = true;
  result.className = "result";
  result.textContent = "正しいプログラムを実行して期待出力を作り、誤りを埋め込んでいます。";

  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: correctSourceInput.value,
        tests: parseTests(testsInput.value),
        options: {
          maxRules: Number(maxRulesInput.value || 4),
        },
      }),
    });
    const payload = await response.json();
    if (!payload.ok) {
      score.textContent = "生成失敗";
      result.className = "result bad";
      result.textContent = payload.message;
      return;
    }

    activeTests = payload.tests;
    renderExercise(payload.parts);
    debugButton.disabled = true;
    resetStatus("問題を生成しました。上から順に確認し、OKだと思った行にチェックを入れながら修正してください。");
    sessionStartTime = Date.now();
    hintStartTime = null;
    sendLog("generate");
    if (!options.silentGuide) {
      setGuideStep(4);
    }
  } catch (error) {
    score.textContent = "生成失敗";
    result.className = "result bad";
    result.textContent = "生成サーバに接続できません。`node server.js`で起動してください。";
  }
}

async function addDebugOutput() {
  if (!exerciseParts.length) {
    result.className = "result bad";
    result.textContent = "先に問題を生成してください。";
    return;
  }

  score.textContent = "cout追加中";
  result.className = "result";
  result.textContent = "問題コードと正解コードに同じcoutを追加し、期待出力を作り直しています。";

  try {
    const response = await fetch("/api/instrument", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: buildSource(),
        correctSource: correctSourceInput.value,
        tests: activeTests.map((test) => ({
          name: test.name,
          input: test.input,
        })),
      }),
    });
    const payload = await response.json();
    if (!payload.ok) {
      score.textContent = "追加失敗";
      result.className = "result bad";
      result.textContent = payload.message;
      return;
    }

    activeTests = payload.tests;
    renderExercise([payload.source]);
    debugButton.disabled = true;
    score.textContent = "未採点";
    result.className = "result";
    result.textContent = "cout入りの問題に切り替えました。期待出力もcout込みで更新されています。";
    hintStartTime = Date.now();
    sendLog("hint");
  } catch (error) {
    score.textContent = "追加失敗";
    result.className = "result bad";
    result.textContent = "生成サーバに接続できません。`node server.js`で起動してください。";
  }
}

async function checkAnswers() {
  advanceGuideTo("check");
  if (!exerciseParts.length) {
    result.className = "result bad";
    result.textContent = "先に問題を生成してください。";
    return;
  }

  score.textContent = "判定中";
  result.className = "result";
  result.textContent = "編集後のC/C++プログラムをコンパイルしてテスト実行しています。";

  try {
    const response = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: buildSource(),
        tests: activeTests,
      }),
    });
    const payload = await response.json();

    score.textContent = payload.ok ? "正解" : "不正解";
    debugButton.disabled = payload.ok;
    result.className = `result ${payload.ok ? "ok" : "bad"}`;
    renderCasePanel({
      ...payload,
      showActual: true,
    });

    const elapsedSeconds = sessionStartTime ? Math.round((Date.now() - sessionStartTime) / 1000) : 0;
    const elapsedAfterHintSeconds = hintStartTime ? Math.round((Date.now() - hintStartTime) / 1000) : 0;

    sendLog("check", {
      resultMessage: payload.ok ? "正解" : "不正解",
      elapsedSeconds: elapsedSeconds,
      elapsedAfterHintSeconds: elapsedAfterHintSeconds
    });

    if (payload.ok) {
      sessionStartTime = null;
      hintStartTime = null;
    }
  } catch (error) {
    score.textContent = "未判定";
    result.className = "result bad";
    result.textContent = "判定サーバに接続できません。`node server.js`で起動してください。";
  }
}

function highlightCodeLine(lineNum, active) {
  const lineId = `l${lineNum}`;
  const codeLineRow = document.querySelector(`.code-line[data-id="${lineId}"]`);
  if (codeLineRow) {
    codeLineRow.classList.toggle("trace-highlight", active);
  }
}

function renderOutputText(container, text) {
  container.replaceChildren();
  const trimmed = (text || "").trimEnd();
  if (!trimmed) {
    return;
  }
  const lines = trimmed.replace(/\r\n/g, "\n").split("\n");
  lines.forEach((lineText, index) => {
    const lineSpan = document.createElement("span");
    lineSpan.className = "output-line";
    
    const match = lineText.match(/\[trace\s+L(\d+)\]/);
    let displayText = lineText;
    if (match) {
      const lineNum = match[1];
      lineSpan.dataset.traceTarget = lineNum;
      lineSpan.classList.add("has-trace");
      
      lineSpan.addEventListener("mouseenter", () => {
        highlightCodeLine(lineNum, true);
      });
      lineSpan.addEventListener("mouseleave", () => {
        highlightCodeLine(lineNum, false);
      });
      
      displayText = lineText.replace(/\[trace\s+L\d+\]\s*/, "");
    }
    
    lineSpan.textContent = displayText + (index < lines.length - 1 ? "\n" : "");
    container.appendChild(lineSpan);
  });
}

function renderCodeLineWithHiddenTrace(element, text) {
  const trimmed = text || "";
  
  // パターン1: 元からある printf / cout 行の前に挿入されたトレース
  // 例: cout << "[trace L66] "; printf("平均...");
  const pattern1 = /^(.*)(cout\s*<<\s*"\[trace\s+L\d+\]\s*"\s*;\s*)(.*)$/;
  const match1 = trimmed.match(pattern1);
  if (match1) {
    element.replaceChildren();
    
    if (match1[1]) {
      element.appendChild(document.createTextNode(match1[1]));
    }
    
    const hiddenSpan = document.createElement("span");
    hiddenSpan.className = "hidden-trace";
    hiddenSpan.contentEditable = "false";
    hiddenSpan.style.display = "none";
    hiddenSpan.textContent = match1[2];
    element.appendChild(hiddenSpan);
    
    if (match1[3]) {
      element.appendChild(document.createTextNode(match1[3]));
    }
    return;
  }

  // パターン2: 自動挿入されたトレース行の中のプレフィックス
  // 例: cout << "[trace L26] size="...
  const pattern2 = /^(.*cout\s*<<\s*")(\[trace\s+L\d+\]\s*)(.*)$/;
  const match2 = trimmed.match(pattern2);
  if (match2) {
    element.replaceChildren();
    
    if (match2[1]) {
      element.appendChild(document.createTextNode(match2[1]));
    }
    
    const hiddenSpan = document.createElement("span");
    hiddenSpan.className = "hidden-trace";
    hiddenSpan.contentEditable = "false";
    hiddenSpan.style.display = "none";
    hiddenSpan.textContent = match2[2];
    element.appendChild(hiddenSpan);
    
    if (match2[3]) {
      element.appendChild(document.createTextNode(match2[3]));
    }
    return;
  }

  element.textContent = text;
}

function resetExercise() {
  renderExercise(exerciseParts);
  resetStatus();
}

correctSourceInput.value = defaultCorrectSource;
testsInput.value = defaultTests;
correctSourceInput.addEventListener("focus", () => setGuideStep(0));
testsInput.addEventListener("focus", () => setGuideStep(1));
maxRulesInput.addEventListener("focus", () => setGuideStep(2));
generateButton.addEventListener("click", generateExercise);
document.querySelector("#checkButton").addEventListener("click", checkAnswers);
debugButton.addEventListener("click", addDebugOutput);
document.querySelector("#resetButton").addEventListener("click", resetExercise);
guidePrev.addEventListener("click", () => setGuideStep(guideIndex - 1));
guideNext.addEventListener("click", () => {
  if (guideIndex === guideSteps.length - 1) {
    setGuideStep(0);
  } else {
    setGuideStep(guideIndex + 1);
  }
});
setGuideStep(0);
generateExercise({ silentGuide: true });
