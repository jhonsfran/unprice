import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs

import jinja2
import yaml

root = Path(os.environ.get("BILLING_PROOF_ROOT", Path(__file__).resolve().parents[2]))
container = os.environ.get("BILLING_PROOF_CONTAINER", "codex-billing-proof-tinybird")
structure = []
source = (root / "internal/analytics/datasources/unprice_entitlement_meter_facts.datasource").read_text()
for name, type_name in re.findall(r"`([^`]+)` (.*?) `json:", source):
    structure.append("`" + name + "` " + type_name)
fixtures = (root / "internal/analytics/fixtures/unprice_entitlement_meter_facts.ndjson").read_text()

def run(pipe, params, rows=fixtures):
    source = (root / "internal/analytics/endpoints" / (pipe + ".pipe")).read_text()
    nodes = re.findall(r"NODE ([^\n]+)\nSQL >\n(.*?)(?=\nNODE |\nTYPE |\Z)", source, re.S)
    env = jinja2.Environment()
    env.globals.update({
        "defined": lambda value: not isinstance(value, jinja2.Undefined),
        "String": lambda value: repr(value),
        "Int64": lambda value: str(int(value)),
        "Array": lambda value, _type: "[" + ",".join(repr(item) for item in value.split(",")) + "]",
    })
    rendered = [(name, env.from_string(sql.strip().removeprefix("%").replace("{% end %}", "{% endif %}")).render(**params)) for name, sql in nodes]
    query = "WITH " + ", ".join(name + " AS (" + sql + ")" for name, sql in rendered) + " SELECT * FROM " + rendered[-1][0] + " FORMAT JSONEachRow"
    command = ["rtk", "proxy", "docker", "exec", "-i", container, "clickhouse-local", "--table", "unprice_entitlement_meter_facts", "--structure", ",".join(structure), "--input-format", "JSONEachRow", "--query", query]
    result = subprocess.run(command, input=rows, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return [json.loads(row) for row in result.stdout.splitlines() if row]

if __name__ == "__main__":
    failed = 0
    for pipe in ["v1_get_feature_usage_no_duplicates", "v1_get_billing_usage_allocations"]:
        tests_path = root / "internal/analytics/tests" / (pipe + ".yaml")
        if not tests_path.exists():
            continue
        for test in yaml.safe_load(tests_path.read_text()):
            params = {key: value[0] for key, value in parse_qs(test["parameters"]).items()}
            expected = [json.loads(row) for row in test["expected_result"].splitlines() if row]
            actual = run(pipe, params)
            passed = actual == expected
            print(("PASS " if passed else "FAIL ") + test["name"] + " expected=" + json.dumps(expected) + " actual=" + json.dumps(actual))
            failed += not passed
    
    facts_path = Path(__file__).with_name("processor-facts.ndjson")
    if facts_path.exists():
        actual = run("v1_get_feature_usage_no_duplicates", {"project_id": "proj_123", "customer_id": "cus_123", "start": "1793102340000", "end": "1793102460000"}, facts_path.read_text())
        expected = [{"project_id": "proj_123", "customer_id": "cus_123", "feature_slug": "api_calls", "latest": 2}]
        passed = actual == expected
        print(("PASS " if passed else "FAIL ") + "actual_processor_late_events_and_replay expected=" + json.dumps(expected) + " actual=" + json.dumps(actual))
        failed += not passed
    base = json.loads(fixtures.splitlines()[0])
    overflow_rows = []
    for index in range(2049):
        overflow_rows.append({
            **base,
            "project_id": "p_overflow", "customer_id": "c_overflow",
            "customer_entitlement_id": "ce_overflow", "grant_id": "grant_overflow",
            "feature_slug": "overflow", "period_key": "day:4070908800000",
            "timestamp": 4070908801000, "created_at": 4070908801000,
            "delta": 1, "value_after": index + 1,
            "amount": 9007199254740991 if index < 2048 else 2048,
            "idempotency_key": str(index),
        })
    actual = run("v1_get_billing_usage_allocations", {
        "project_id": "p_overflow", "customer_id": "c_overflow",
        "customer_entitlement_ids": "ce_overflow", "feature_slugs": "overflow",
        "start": "4070908800000", "end": "4070995200000",
    }, "\n".join(json.dumps(row) for row in overflow_rows))
    passed = (len(actual) == 1
              and float(actual[0].get("amount", 0)) == float(18446744073709551616)
              and actual[0]["amount"] > 9007199254740991)
    print(("PASS " if passed else "FAIL ") + "unsafe_money_does_not_wrap_to_zero actual=" + json.dumps(actual))
    failed += not passed
    print("Failed checks " + str(failed))
    sys.exit(1 if failed else 0)
