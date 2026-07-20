#!/usr/bin/env python3
"""
One-time (idempotent) importer: loads the 4 CompanyDetails/*.xlsx rosters into Supabase.

Zero third-party dependencies — an .xlsx is a zip of XML (parsed with stdlib `zipfile`),
and rows are upserted through the Supabase REST API with stdlib `urllib`.

Usage:
    python scripts/import_employees.py            # parse + upsert to Supabase
    python scripts/import_employees.py --dry-run  # parse + print counts only (no network, no keys needed)

Reads SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY from .env.local
(or the real environment). The service_role key bypasses RLS, so run this only from a trusted machine.

Idempotent: entities upsert on `code`, branches on `(entity_id,code)`, designations on
`(entity_id,title)`, employees on `(entity_id,employee_code)`. Re-running updates in place.
"""
import os
import re
import sys
import json
import glob
import zipfile
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(SCRIPT_DIR)   # .../backend
REPO_ROOT = os.path.dirname(BACKEND_DIR)    # repo root


def _first_existing(*paths):
    for p in paths:
        if p and os.path.exists(p):
            return p
    return paths[0]


# CompanyDetails lives under backend/ after the frontend/backend split, but fall back to repo root.
DETAILS_DIR = _first_existing(
    os.path.join(BACKEND_DIR, "CompanyDetails"),
    os.path.join(REPO_ROOT, "CompanyDetails"),
)
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}"

DRY_RUN = "--dry-run" in sys.argv

# ---- entity + per-file configuration ---------------------------------------
ENTITIES = [
    {"code": "PPI", "name": "P.P. Imitations Pvt Ltd", "legal_name": "P.P. Imitations Pvt Ltd"},
    {"code": "PPJ", "name": "Parakkat Pearls and Jewels India Pvt Ltd", "legal_name": "Parakkat Pearls and Jewels India Pvt Ltd"},
    {"code": "PJT", "name": "Parakkat Jewels Trading", "legal_name": "Parakkat Jewels Trading"},
]

# Each source file -> which entity, a code tag to keep employee_code unique across files of the
# same entity, and how to resolve the branch for each row.
FILES = [
    {"glob": "*PP IMITATIONS*.xlsx",        "entity": "PPI", "tag": "",   "branch_mode": "none"},
    {"glob": "*PEARLS - HEAD OFFICE*.xlsx", "entity": "PPJ", "tag": "HO", "branch_mode": "fixed", "branch_code": "HO", "branch_name": "Head Office"},
    {"glob": "*PEARLS AND JEWELS - BRANCHES*.xlsx", "entity": "PPJ", "tag": "BR", "branch_mode": "column"},
    {"glob": "*Parakkat Jewels Trading*.xlsx", "entity": "PJT", "tag": "",  "branch_mode": "none"},
]


# ---- xlsx parsing (stdlib only) --------------------------------------------
def _col_to_idx(ref):
    s = re.match(r"([A-Z]+)", ref).group(1)
    n = 0
    for ch in s:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def read_first_sheet(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(NS + "si"):
            shared.append("".join(t.text or "" for t in si.iter(NS + "t")))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    r2t = {r.get("Id"): r.get("Target") for r in rels.findall(PKG + "Relationship")}
    sheet = wb.find(NS + "sheets").find(NS + "sheet")
    tgt = r2t[sheet.get(RNS + "id")]
    if not tgt.startswith("xl/"):
        tgt = "xl/" + tgt
    sroot = ET.fromstring(z.read(tgt))
    rows = []
    for row in sroot.find(NS + "sheetData").findall(NS + "row"):
        cells, maxc = {}, 0
        for c in row.findall(NS + "c"):
            ci = _col_to_idx(c.get("r", "A1"))
            maxc = max(maxc, ci)
            t = c.get("t")
            v = c.find(NS + "v")
            if t == "s" and v is not None:
                val = shared[int(v.text)]
            elif v is not None:
                val = v.text
            else:
                val = ""
            cells[ci] = val
        rows.append([str(cells.get(i, "")).strip() for i in range(maxc + 1)])
    return rows


def parse_file(path, cfg):
    """Return list of {slno, name, designation, branch_code, branch_name} for one roster."""
    rows = read_first_sheet(path)
    hi = next((i for i, r in enumerate(rows) if any("designation" in c.lower() for c in r)), 1)
    hdr = rows[hi]
    di = next(i for i, c in enumerate(hdr) if "designation" in c.lower())
    ni = next(i for i, c in enumerate(hdr) if "employee name" in c.lower())
    bi = next((i for i, c in enumerate(hdr) if c.lower() == "branch"), None)
    out = []
    seq = 0
    for r in rows[hi + 1:]:
        name = r[ni] if ni < len(r) else ""
        if not name:
            continue
        seq += 1
        desig = (r[di] if di < len(r) else "").strip()
        branch_code, branch_name = None, None
        if cfg["branch_mode"] == "fixed":
            branch_code, branch_name = cfg["branch_code"], cfg.get("branch_name")
        elif cfg["branch_mode"] == "column" and bi is not None:
            b = (r[bi] if bi < len(r) else "").strip()
            # Rows like "ZONAL MANAGER"/"REGIONAL MANAGER" in the Branch column are managers
            # not tied to a branch -> leave branch null (entity-level).
            if b and "MANAGER" not in b.upper():
                branch_code = b.upper()
        out.append({
            "slno": seq,
            "name": name,
            "designation": desig,
            "branch_code": branch_code,
            "branch_name": branch_name,
        })
    return out


# ---- Supabase REST client (stdlib) -----------------------------------------
def load_env():
    env = dict(os.environ)
    envfile = _first_existing(
        os.path.join(BACKEND_DIR, ".env.local"),
        os.path.join(REPO_ROOT, ".env.local"),
    )
    if os.path.exists(envfile):
        with open(envfile, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip())
    url = env.get("SUPABASE_URL") or env.get("VITE_SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    return url, key


class Supa:
    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1"
        self.key = key

    def upsert(self, table, rows, on_conflict):
        if not rows:
            return []
        q = "?on_conflict=" + on_conflict
        req = urllib.request.Request(
            self.base + "/" + table + q,
            data=json.dumps(rows).encode("utf-8"),
            method="POST",
            headers={
                "apikey": self.key,
                "Authorization": "Bearer " + self.key,
                "Content-Type": "application/json",
                "Prefer": "return=representation,resolution=merge-duplicates",
            },
        )
        try:
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            raise SystemExit(f"[{table}] HTTP {e.code}: {body}")


# ---- main -------------------------------------------------------------------
def main():
    # 1) parse every roster
    parsed = []  # (cfg, rows)
    for cfg in FILES:
        matches = glob.glob(os.path.join(DETAILS_DIR, cfg["glob"]))
        if not matches:
            print(f"  ! no file matched {cfg['glob']}", file=sys.stderr)
            continue
        rows = parse_file(matches[0], cfg)
        parsed.append((cfg, rows))
        print(f"  parsed {len(rows):3} rows from {os.path.basename(matches[0])}")

    total = sum(len(r) for _, r in parsed)
    # distinct branches (from data) and designations (per entity)
    branches = {}   # (entity, code) -> name
    desigs = {}     # entity -> set(title)
    for cfg, rows in parsed:
        ent = cfg["entity"]
        desigs.setdefault(ent, set())
        for r in rows:
            if r["designation"]:
                desigs[ent].add(r["designation"])
            if r["branch_code"]:
                branches[(ent, r["branch_code"])] = r["branch_name"] or r["branch_code"]

    print(f"\n  entities: {len(ENTITIES)}  branches: {len(branches)}  "
          f"designations: {sum(len(s) for s in desigs.values())}  employees: {total}")

    if DRY_RUN:
        print("\n  --dry-run: parsed only, nothing sent.")
        return

    url, key = load_env()
    if not url or not key:
        raise SystemExit("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY "
                         "(set them in .env.local). Use --dry-run to test parsing without keys.")
    db = Supa(url, key)

    # 2) entities
    ent_rows = db.upsert("entities", ENTITIES, "code")
    ent_id = {e["code"]: e["id"] for e in ent_rows}
    print(f"  upserted {len(ent_rows)} entities")

    # 3) branches
    br_payload = [{"entity_id": ent_id[ent], "code": code, "name": name}
                  for (ent, code), name in branches.items()]
    br_rows = db.upsert("branches", br_payload, "entity_id,code")
    br_id = {(r["entity_id"], r["code"]): r["id"] for r in br_rows}
    print(f"  upserted {len(br_rows)} branches")

    # 4) designations (per entity)
    des_payload = []
    for ent, titles in desigs.items():
        for t in sorted(titles):
            des_payload.append({"entity_id": ent_id[ent], "title": t})
    des_rows = db.upsert("designations", des_payload, "entity_id,title")
    des_id = {(r["entity_id"], r["title"]): r["id"] for r in des_rows}
    print(f"  upserted {len(des_rows)} designations")

    # 5) employees
    emp_payload = []
    for cfg, rows in parsed:
        ent = cfg["entity"]
        eid = ent_id[ent]
        tag = ("-" + cfg["tag"]) if cfg["tag"] else ""
        for r in rows:
            code = f"{ent}{tag}-{r['slno']:04d}"
            bid = br_id.get((eid, r["branch_code"])) if r["branch_code"] else None
            emp_payload.append({
                "entity_id": eid,
                "branch_id": bid,
                "designation_id": des_id.get((eid, r["designation"])) if r["designation"] else None,
                "employee_code": code,
                "full_name": r["name"],
                "status": "Active",
                "meta": {"source_designation": r["designation"], "source_branch": r["branch_code"]},
            })
    # upsert in chunks to keep request sizes sane
    done = 0
    for i in range(0, len(emp_payload), 200):
        chunk = emp_payload[i:i + 200]
        db.upsert("employees", chunk, "entity_id,employee_code")
        done += len(chunk)
    print(f"  upserted {done} employees")
    print("\n  Done. Next: sign up prteam@parakkatjewels.com, then run in the SQL editor:")
    print("    select public.bootstrap_super_admin('prteam@parakkatjewels.com');")


if __name__ == "__main__":
    main()
