import pytest

from evaluation import evaluate

NORMAL = {"ph": 7.2, "turbidity": 1.8, "tds": 320, "temperature": 26.5}


def reading(**changes):
    return {**NORMAL, **changes}


def test_normal():
    assert evaluate(NORMAL) == ("NORMAL", [])


@pytest.mark.parametrize("changes", [
    {"ph": 6.5}, {"ph": 8.5}, {"turbidity": 5}, {"tds": 500}, {"temperature": 10}, {"temperature": 35}, {"turbidity": 0},
])
def test_limits_are_inclusive(changes):
    assert evaluate(reading(**changes))[0] == "NORMAL"


@pytest.mark.parametrize("param,value,direction", [
    ("ph", 8.8, "above"), ("ph", 6.2, "below"), ("turbidity", 7.5, "above"),
    ("tds", 750, "above"), ("temperature", 37, "above"), ("temperature", 7, "below"),
])
def test_warning(param, value, direction):
    status, violations = evaluate(reading(**{param: value}))
    assert status == "WARNING"
    assert len(violations) == 1
    v = violations[0]
    assert (v["parameter"], v["severity"], v["direction"], v["value"]) == (param, "WARNING", direction, value)


@pytest.mark.parametrize("param,value,limit", [
    ("ph", 5.5, 6.0), ("ph", 9.5, 9.0), ("turbidity", 12, 10), ("tds", 1200, 1000), ("temperature", 42, 40),
])
def test_critical(param, value, limit):
    status, violations = evaluate(reading(**{param: value}))
    assert status == "CRITICAL"
    assert violations[0]["severity"] == "CRITICAL"
    assert violations[0]["limit"] == limit


def test_mixed_takes_worst_and_lists_all():
    status, violations = evaluate(reading(turbidity=7, tds=1500))
    assert status == "CRITICAL"
    assert {(v["parameter"], v["severity"]) for v in violations} == {("turbidity", "WARNING"), ("tds", "CRITICAL")}


def test_message_explains_the_trigger():
    _, [v] = evaluate(reading(ph=5.5))
    assert v["message"] == "pH 5.5 is below the critical limit of 6.0"
