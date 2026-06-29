const correctSourceInput = document.querySelector("#correctSource");
const testsInput = document.querySelector("#testsInput");
const generateButton = document.querySelector("#generateButton");
const maxRulesInput = document.querySelector("#maxRules");
const exercise = document.querySelector("#exercise");
const result = document.querySelector("#result");
const score = document.querySelector("#score");
const editableTemplate = document.querySelector("#editableTemplate");
const guideText = document.querySelector("#guideText");
const guidePrev = document.querySelector("#guidePrev");
const guideNext = document.querySelector("#guideNext");

const guideSteps = [
  {
    target: "source",
    text: "正しく動くCプログラムを貼り付けます。すでに誤りが入ったコードではなく、正解コードを入れてください。",
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
    text: "生成された問題です。色付きのブロックをクリックして、必要だと思う箇所を正しいコードに修正します。編集しないブロックがあってもかまいません。",
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
const editableById = new Map();

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

function resetStatus(message = "色付きのブロックをクリックして編集できます。") {
  for (const editable of editableById.values()) {
    editable.classList.remove("checked");
  }
  score.textContent = "未採点";
  result.className = "result";
  result.textContent = message;
}

function makeEditable(slot) {
  const node = editableTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = slot.id;
  node.contentEditable = "true";
  node.textContent = slot.initial;
  node.title = slot.note;
  node.addEventListener("input", () => resetStatus());
  node.addEventListener("focus", () => node.classList.add("active"));
  node.addEventListener("blur", () => node.classList.remove("active"));
  editableById.set(slot.id, node);
  return node;
}

function renderExercise(parts) {
  exerciseParts = parts;
  editableById.clear();
  exercise.replaceChildren();

  for (const part of exerciseParts) {
    if (typeof part === "string") {
      exercise.append(document.createTextNode(part));
    } else {
      exercise.append(makeEditable(part));
    }
  }
}

function buildSource() {
  let source = "";
  for (const part of exerciseParts) {
    source += typeof part === "string" ? part : editableById.get(part.id).textContent;
  }
  return source;
}

function renderCheckResult(payload) {
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

    const expectedLabel = document.createElement("span");
    expectedLabel.textContent = payload.ok ? "出力" : "期待される出力";
    const expected = document.createElement("pre");
    expected.textContent = (payload.ok ? test.actual : test.expected).trimEnd();

    item.append(title, inputLabel, input, expectedLabel, expected);

    if (!payload.ok && test.actual !== undefined) {
      const actualLabel = document.createElement("span");
      actualLabel.textContent = "実際の出力";
      const actual = document.createElement("pre");
      actual.textContent = test.actual.trimEnd();
      item.append(actualLabel, actual);
    }

    list.append(item);
  }

  result.append(list);
}

async function generateExercise(options = {}) {
  if (!options.silentGuide) {
    advanceGuideTo("generate");
  }
  score.textContent = "生成中";
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
    const ruleNames = payload.slots.map((slot) => slot.ruleTitle).join("、");
    resetStatus(`${payload.slots.length}個の編集可能箇所を持つ問題を生成しました。適用ルール: ${ruleNames}`);
    if (!options.silentGuide) {
      setGuideStep(4);
    }
  } catch (error) {
    score.textContent = "生成失敗";
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
  result.textContent = "編集後のCプログラムをコンパイルしてテスト実行しています。";

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

    for (const editable of editableById.values()) {
      editable.classList.toggle("checked", payload.ok);
    }

    score.textContent = payload.ok ? "正解" : "不正解";
    result.className = `result ${payload.ok ? "ok" : "bad"}`;
    renderCheckResult(payload);
  } catch (error) {
    score.textContent = "未判定";
    result.className = "result bad";
    result.textContent = "判定サーバに接続できません。`node server.js`で起動してください。";
  }
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
