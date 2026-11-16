import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/evaluation.mjs";

const NORMAL = { ph: 7.2, turbidity: 1.8, tds: 320, temperature: 26.5 };
const reading = (changes) => ({ ...NORMAL, ...changes });

test("normal readings", () => {
  assert.deepEqual(evaluate(NORMAL), { status: "NORMAL", violations: [] });
});

test("limits are inclusive", () => {
  for (const changes of [{ ph: 6.5 }, { ph: 8.5 }, { turbidity: 5 }, { tds: 500 }, { temperature: 10 }, { temperature: 35 }, { turbidity: 0 }]) {
    assert.equal(evaluate(reading(changes)).status, "NORMAL", JSON.stringify(changes));
  }
});

test("warning readings", () => {
  const cases = [["ph", 8.8, "above"], ["ph", 6.2, "below"], ["turbidity", 7.5, "above"],
    ["tds", 750, "above"], ["temperature", 37, "above"], ["temperature", 7, "below"]];
  for (const [param, value, direction] of cases) {
    const { status, violations } = evaluate(reading({ [param]: value }));
    assert.equal(status, "WARNING");
    assert.equal(violations.length, 1);
    assert.deepEqual(
      [violations[0].parameter, violations[0].severity, violations[0].direction, violations[0].value],
      [param, "WARNING", direction, value],
    );
  }
});

test("critical readings", () => {
  const cases = [["ph", 5.5, 6], ["ph", 9.5, 9], ["turbidity", 12, 10], ["tds", 1200, 1000], ["temperature", 42, 40]];
  for (const [param, value, limit] of cases) {
    const { status, violations } = evaluate(reading({ [param]: value }));
    assert.equal(status, "CRITICAL");
    assert.equal(violations[0].severity, "CRITICAL");
    assert.equal(violations[0].limit, limit);
  }
});

test("mixed readings take the worst status and list every violation", () => {
  const { status, violations } = evaluate(reading({ turbidity: 7, tds: 1500 }));
  assert.equal(status, "CRITICAL");
  assert.deepEqual(
    violations.map((v) => [v.parameter, v.severity]).sort(),
    [["tds", "CRITICAL"], ["turbidity", "WARNING"]],
  );
});

test("message explains which parameter triggered it", () => {
  const { violations: [v] } = evaluate(reading({ ph: 5.5 }));
  assert.equal(v.message, "pH 5.50 is below the critical limit of 6.00");
  const { violations: [t] } = evaluate(reading({ tds: 1200 }));
  assert.equal(t.message, "Total Dissolved Solids 1200 mg/L is above the critical limit of 1000 mg/L");
});
