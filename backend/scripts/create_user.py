#!/usr/bin/env python3
"""
Provision a login for the HR system (creates an auth user via the Supabase Admin API).
Creating auth users needs the service_role key, which must never live in the browser — hence this
runs on your machine. After creating the login, assign roles/scopes to it from the app's
Administration -> Users & Access screen.

Usage:
    python backend/scripts/create_user.py someone@parakkat.com
    python backend/scripts/create_user.py someone@parakkat.com --password "Chosen#Pass1"
    python backend/scripts/create_user.py boss@parakkat.com --super-admin

Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from backend/.env.local.
"""
import os
import sys
import json
import secrets
import string
import urllib.request
import urllib.error

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env():
    env = dict(os.environ)
    for path in (os.path.join(BACKEND_DIR, ".env.local"),
                 os.path.join(os.path.dirname(BACKEND_DIR), ".env.local")):
        if os.path.exists(path):
            for line in open(path, encoding="utf-8"):
                s = line.strip()
                if s and not s.startswith("#") and "=" in s:
                    k, v = s.split("=", 1)
                    env.setdefault(k.strip(), v.strip())
    return env


def call(url, path, key, method="POST", body=None):
    req = urllib.request.Request(
        url.rstrip("/") + path,
        data=(json.dumps(body).encode() if body is not None else None),
        method=method,
        headers={"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        return e.code, (json.loads(t) if t.strip().startswith(("{", "[")) else t)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    if not args:
        print("Usage: python backend/scripts/create_user.py <email> [--password PW] [--super-admin]")
        raise SystemExit(1)
    email = args[0]
    make_super = "--super-admin" in flags
    password = None
    if "--password" in sys.argv:
        password = sys.argv[sys.argv.index("--password") + 1]
    generated = password is None
    if generated:
        password = "Pk" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(11)) + "#9"

    env = load_env()
    url = env.get("SUPABASE_URL") or env.get("VITE_SUPABASE_URL")
    svc = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not svc or "YOUR-PROJECT" in url:
        raise SystemExit("Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in backend/.env.local first.")

    status, body = call(url, "/auth/v1/admin/users", svc,
                        body={"email": email, "password": password, "email_confirm": True})
    if status in (200, 201):
        uid = body["id"]
        print(f"Created login: {email}")
        print(f"  password: {password}" + ("  (generated — change after first login)" if generated else ""))
    elif status in (400, 409, 422):
        # already exists
        st, lst = call(url, "/auth/v1/admin/users?per_page=200", svc, method="GET")
        uid = next((u["id"] for u in (lst or {}).get("users", []) if u.get("email", "").lower() == email.lower()), None)
        if not uid:
            raise SystemExit(f"User exists but could not be located: {status} {body}")
        print(f"Login already exists: {email} (password unchanged)")
    else:
        raise SystemExit(f"Failed to create user: {status} {body}")

    if make_super:
        call(url, "/rest/v1/profiles?on_conflict=user_id", svc,
             body={"user_id": uid, "is_super_admin": True})
        call(url, f"/rest/v1/profiles?user_id=eq.{uid}", svc, method="PATCH",
             body={"is_super_admin": True})
        print("  promoted to SUPER ADMIN")

    print("\nNext: open the app -> Administration -> Users & Access to link this login to an employee")
    print("and grant a role at a scope (e.g. HR Manager @ branch CDA).")


if __name__ == "__main__":
    main()
